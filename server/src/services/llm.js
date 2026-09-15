/**
 * LLM provider abstraction: ONE interface, two providers.
 *
 * docs/02_TRD.md §6 and docs/05_AWS_ARCHITECTURE.md:
 *
 *     generateJSON({ system, prompt, schema })
 *
 * Bedrock is the primary provider, reached through the Converse API so that
 * switching model family is a config change rather than a code change. Groq is
 * the fallback. Which model serves which task is set in TASK_MODELS below.
 *
 * There is never an anonymous third-party proxy in the chain. Sending user API
 * payloads to an unauthenticated endpoint has no place in a security tool.
 *
 * WHY THIS IS A SERVICE AND NOT AN MCP TOOL
 * The MCP layer governs actions taken against USER-NOMINATED targets: that is
 * what needs a permission gate, an SSRF guard and a per-host audit row. An LLM
 * call goes to a fixed, first-party endpoint and is the agent's own reasoning,
 * not an action on a user's behalf. The architecture guard forbids network I/O
 * inside server/src/agents/**, and an agent reaching a model through this
 * service does not violate that: no agent opens a socket, and nothing here can
 * be pointed at a host the user supplied.
 *
 * Token usage is returned on every call because docs/01_PRD.md F10 requires
 * cost and latency per run in the evaluation.
 */
import axios from 'axios';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { parseLooseJson } from './jsonRepair.js';
import { callAiProvider } from './ai-providers.js';
import { getActiveProviderConfig } from './providers.service.js';

export class LlmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.details = details;
  }
}

/** Longest we will sit waiting out a single provider rate limit. */
export const RATE_LIMIT_MAX_WAIT_MS = 30_000;
/**
 * How many times to wait out a rate limit before abandoning a provider.
 *
 * One retry was not enough: a free tier that limits tokens-per-minute will
 * refuse several calls in a row during a burst, and an evaluation run makes
 * eight generation calls back to back. Three bounded waits cover a burst
 * without letting a genuinely exhausted quota hang the process indefinitely.
 */
export const RATE_LIMIT_MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export const LLM_ERROR = {
  NO_PROVIDER: 'LLM_NO_PROVIDER',
  PROVIDER_FAILED: 'LLM_PROVIDER_FAILED',
  INVALID_JSON: 'LLM_INVALID_JSON',
  SCHEMA_MISMATCH: 'LLM_SCHEMA_MISMATCH',
  RATE_LIMITED: 'LLM_RATE_LIMITED',
};

/**
 * Published per-million-token list prices, for the cost column of the
 * evaluation report.
 *
 * A model missing from this table yields `null` rather than a guess, and the
 * report prints "unknown": an invented cost would be worse than no cost.
 */
export const PRICING = {
  'openai/gpt-oss-20b': { in: 0.1, out: 0.5 },
  'openai/gpt-oss-120b': { in: 0.15, out: 0.75 },
  'qwen/qwen3.6-27b': { in: 0.29, out: 0.59 },
  // Retired by Groq in 2026. Kept so historical runs still cost out.
  'llama-3.1-8b-instant': { in: 0.05, out: 0.08 },
  'apac.amazon.nova-lite-v1:0': { in: 0.06, out: 0.24 },
  'apac.amazon.nova-micro-v1:0': { in: 0.035, out: 0.14 },
  'apac.amazon.nova-pro-v1:0': { in: 0.8, out: 3.2 },
  // DeepSeek V3.2 on Bedrock (ap-south-1). Invokes on-demand with the bare model
  // id, no inference profile needed.
  'deepseek.v3.2': { in: 0.62, out: 1.85 },
};

export function estimateCostUsd(model, inputTokens, outputTokens) {
  const p = PRICING[model];
  if (!p) return null;
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

// ── Providers ────────────────────────────────────────────────────────────────

/**
 * CONFIGURABLE ON PURPOSE.
 *
 * This was pinned to a literal, and Groq retired that model, which broke
 * generation everywhere with an opaque 404. Providers deprecate models on their
 * own schedule, so the model id is an environment variable with a current
 * default, and swapping it is a config change rather than a code change.
 */
/**
 * Default model.
 *
 * 20b proved unreliable at this schema: malformed cases, over-long batches and
 * occasional invalid JSON, each of which cost a full generation attempt. 120b
 * holds the shape far more consistently and the workload is small enough that
 * the price difference is fractions of a cent per evaluation run.
 */
/**
 * ── MODEL ROUTING BY TASK ───────────────────────────────────────────────────
 *
 * AGENTIQ asks the LLM for two different things, and paying one rate for both
 * is waste. Bedrock is primary (AWS-native per docs/05_AWS_ARCHITECTURE.md,
 * cheaper and faster than Groq, and with no free-tier tokens-per-minute limit,
 * that limit aborted three evaluation runs). Groq is the fallback.
 *
 *   generation   5 executable test cases as structured JSON, grounded in an
 *                OpenAPI operation. Long output, strict schema, once per run,
 *                and it determines the quality of the entire suite.
 *
 *   explanation  Two sentences on why one assertion failed. ~200 tokens, free
 *                prose, best-effort and time-boxed (docs/03_App_Flow.md B7).
 *                Once per FAILURE, so it is the higher-volume task.
 *
 * ── THE TIERS ARE MEASURED, NOT ASSUMED ─────────────────────────────────────
 * The obvious assignment, cheapest model for the cheap task, is wrong here,
 * and measuring is what showed it. On the explanation task (n=6 each):
 *
 *   nova-micro   3/6 succeeded, mean 1115 ms
 *   nova-lite    6/6 succeeded, mean  903 ms
 *
 * Micro's cheaper tokens are false economy: explanations run with maxRepairs=0
 * by design, so half of Micro's calls produce nothing while still costing
 * tokens. Per SUCCESSFUL explanation it is both dearer and slower than Lite.
 *
 * On generation the full evaluation harness is run end to end per model. The
 * earlier Nova/Groq table (mutation score, 3 repeats each) was:
 *
 *   nova-lite    46.7% grounded (range 40-50%)   $0.0042 per run
 *   nova-pro     33.3% grounded (range 30-40%)   $0.0559 per run   13x dearer
 *   groq 120b    26.7% grounded                  $0.0131 per run
 *
 * Nova-lite beat the pricier Pro on every repeat, so bigger was not better among
 * the Nova tier. DeepSeek V3.2 then cleared all of them: 63.3% grounded with
 * 23 TP / 0 FP / 1 FN on the security fixtures in a single harness run, at
 * $0.62 / $1.85 per 1M tokens. That margin is large enough to adopt it for
 * generation now; a 3-repeat confirmation is the obvious follow-up.
 *
 * So on Bedrock the two tasks now DIVERGE: generation uses DeepSeek V3.2 (best
 * measured), explanation stays on nova-lite (cheap, and adequate for ~200 tokens
 * of prose). The Groq fallback likewise splits 120b / 20b. The routing exists
 * for exactly this.
 *
 * Every entry is overridable by environment variable, because the thing this
 * file has already learned the hard way is that providers retire models on
 * their own schedule.
 */
export const TASK = {
  GENERATION: 'generation',
  EXPLANATION: 'explanation',
};

export const TASK_MODELS = {
  [TASK.GENERATION]: {
    bedrock: () => env.BEDROCK_MODEL_ID ?? 'deepseek.v3.2',
    groq: () => env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
  },
  [TASK.EXPLANATION]: {
    /**
     * NOT `?? BEDROCK_MODEL_ID`: that term made every deployment collapse back
     * to the generation model, because BEDROCK_MODEL_ID is always set. The
     * explanation tier is its own setting or its own default, never inherited.
     *
     * Lite rather than Micro, on the measurement above.
     */
    bedrock: () => env.BEDROCK_MODEL_EXPLAIN ?? 'apac.amazon.nova-lite-v1:0',
    groq: () => env.GROQ_MODEL_EXPLAIN ?? 'openai/gpt-oss-20b',
  },
};

/** The model this provider should use for this task. */
export function modelFor(task, provider) {
  return TASK_MODELS[task]?.[provider]?.() ?? TASK_MODELS[TASK.GENERATION][provider]?.() ?? null;
}

export const GROQ_MODEL = 'openai/gpt-oss-120b';
export const groqModel = () => env.GROQ_MODEL ?? GROQ_MODEL;

/**
 * Reasoning models spend output tokens THINKING before they answer, and that
 * budget comes out of the same max_tokens allowance as the answer.
 *
 * With the default effort, gpt-oss routinely spent ~1,300 tokens reasoning and
 * then truncated mid-object, so Groq's JSON-mode validator rejected the whole
 * completion with an opaque 400 ("Failed to validate JSON"). Raising max_tokens
 * is not available as a fix: 8,000 exceeds the free tier's per-request size cap.
 *
 * Low effort more than halves the reasoning spend AND returns more actual JSON,
 * which is the right trade for a task whose output is a fixed schema rather
 * than an argument.
 */
const REASONING_MODELS = /gpt-oss|qwen3/i;
export const isReasoningModel = (model) => REASONING_MODELS.test(model);

/** Groq: OpenAI-compatible chat completions with JSON mode. */
async function callGroq({ system, prompt, maxTokens, temperature, signal, model }) {
  if (!env.GROQ_API_KEY) throw new LlmError(LLM_ERROR.NO_PROVIDER, 'GROQ_API_KEY is not set');

  let res;
  try {
    res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: maxTokens,
        ...(isReasoningModel(model) ? { reasoning_effort: 'low' } : {}),
      },
      {
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        timeout: 60_000,
        signal,
      },
    );
  } catch (err) {
    if (err.response?.status === 429) {
      // Surface how long the provider asked us to wait, so the caller can
      // actually honour it instead of failing a whole evaluation run over a
      // transient free-tier limit.
      const header = err.response.headers?.['retry-after'];
      const retryAfterMs = header ? Math.ceil(Number(header) * 1000) : null;
      throw new LlmError(
        LLM_ERROR.RATE_LIMITED,
        `Groq rate limit reached${retryAfterMs ? ` (retry after ${Math.ceil(retryAfterMs / 1000)}s)` : ''}`,
        { provider: 'groq', retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null },
      );
    }
    // Include what the provider actually said. "Request failed with status
    // code 400" is useless on its own; the body names the offending field.
    const detail = err.response?.data?.error?.message
      ?? (typeof err.response?.data === 'string' ? err.response.data.slice(0, 300) : null);
    throw new LlmError(
      LLM_ERROR.PROVIDER_FAILED,
      `Groq request failed (${err.response?.status ?? 'no status'})${detail ? `: ${detail}` : `: ${err.message}`}`,
      { provider: 'groq', status: err.response?.status, detail },
    );
  }

  const usage = res.data?.usage ?? {};
  return {
    text: res.data?.choices?.[0]?.message?.content ?? '',
    provider: 'groq',
    model,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

let bedrockClient = null;

/**
 * Bedrock via the Converse API.
 *
 * Converse normalises request and response across every model family, so
 * BEDROCK_MODEL_ID can be swapped between Nova, Qwen, Mistral or Claude without
 * touching this function. invoke-model would need a different body per vendor.
 *
 * BEDROCK_MODEL_ID must be an INFERENCE PROFILE id (a `global.` / `apac.` /
 * `us.` prefix). A bare model id fails with "on-demand throughput isn't
 * supported": see docs/05_AWS_ARCHITECTURE.md.
 */
async function callBedrock({ system, prompt, maxTokens, temperature, model }) {
  if (!model) {
    throw new LlmError(LLM_ERROR.NO_PROVIDER, 'BEDROCK_MODEL_ID is not set');
  }

  const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  bedrockClient ??= new BedrockRuntimeClient({ region: env.AWS_REGION });

  let res;
  try {
    res = await bedrockClient.send(new ConverseCommand({
      modelId: model,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens, temperature },
    }));
  } catch (err) {
    if (err.name === 'ThrottlingException') {
      throw new LlmError(LLM_ERROR.RATE_LIMITED, 'Bedrock throttled', { provider: 'bedrock' });
    }
    throw new LlmError(LLM_ERROR.PROVIDER_FAILED, `Bedrock request failed: ${err.message}`, {
      provider: 'bedrock',
      awsCode: err.name,
    });
  }

  return {
    text: res.output?.message?.content?.[0]?.text ?? '',
    provider: 'bedrock',
    model,
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
  };
}

export const PROVIDERS = { groq: callGroq, bedrock: callBedrock };

/** Which providers are actually usable right now. Drives /api/health. */
export function availableProviders() {
  return {
    groq: Boolean(env.GROQ_API_KEY),
    bedrock: Boolean(env.BEDROCK_MODEL_ID),
  };
}

/** Primary first, then fallback, skipping anything unconfigured. */
export function providerOrder({ primary = env.LLM_PRIMARY, fallback = env.LLM_FALLBACK } = {}) {
  const available = availableProviders();
  return [primary, fallback].filter((p, i, arr) => p && available[p] && arr.indexOf(p) === i);
}

// ── The one interface ────────────────────────────────────────────────────────

/**
 * Generate JSON validated against a Zod schema.
 *
 * ONE bounded repair retry, then a visible failure. There is NO hardcoded
 * fallback: canned test cases returned when the model fails would make a
 * broken run look like a successful one. A generation failure must surface as
 * an error (docs/03_App_Flow.md B1).
 *
 * @returns {Promise<{data, provider, model, inputTokens, outputTokens, costUsd,
 *                    attempts, repairStage, durationMs}>}
 */
export async function generateJSON({
  system,
  prompt,
  schema,
  maxTokens = 2048,
  temperature = 0.2,
  maxRepairs = 1,
  providers = providerOrder(),
  task = TASK.GENERATION,
  signal,
  // A pre-resolved chain of { name, call, model } entries, used for BYOK: a
  // user's own provider first, the platform's env chain behind it as fallback.
  // When null, the chain is built from `providers` and the env config, which is
  // the platform-key path.
  providerChain = null,
} = {}) {
  const chain = providerChain ?? providers.map((name) => ({
    name, call: PROVIDERS[name], model: modelFor(task, name),
  }));
  if (!chain.length) {
    throw new LlmError(
      LLM_ERROR.NO_PROVIDER,
      'No LLM provider is configured. Set GROQ_API_KEY or BEDROCK_MODEL_ID.',
    );
  }

  const started = Date.now();
  const failures = [];

  for (const { name, call, model } of chain) {
    let lastText = null;
    let lastIssue = null;
    let rateLimitWaits = 0;

    for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
      // The repair attempt shows the model its own output and the specific
      // problem, rather than blindly asking again: a bare retry at the same
      // temperature usually reproduces the same malformed shape.
      const effectivePrompt = attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous reply could not be used: ${lastIssue}\n` +
          `Previous reply:\n${String(lastText).slice(0, 1500)}\n\n` +
          'Reply again with ONLY valid JSON matching the required shape. No prose, no code fences.';

      let raw;
      try {
        raw = await call({
          system, prompt: effectivePrompt, maxTokens, temperature, signal, model,
        });
      } catch (err) {
        // A rate limit is a "come back shortly", not a failure of this
        // provider. Wait once: honouring Retry-After when the provider sent
        // one: before giving up on it.
        if (err.code === LLM_ERROR.RATE_LIMITED && rateLimitWaits < RATE_LIMIT_MAX_RETRIES) {
          rateLimitWaits += 1;
          const waitMs = Math.min(err.details?.retryAfterMs ?? 5_000, RATE_LIMIT_MAX_WAIT_MS);
          logger.warn({ provider: name, waitMs, attempt: rateLimitWaits },
            'LLM rate limited; waiting before retry');
          await sleep(waitMs);
          attempt -= 1; // this attempt never happened
          continue;
        }
        failures.push(`${name}: ${err.message}`);
        break; // try the next provider
      }

      lastText = raw.text;

      const parsed = parseLooseJson(raw.text);
      if (!parsed.ok) {
        lastIssue = 'the reply was not valid JSON';
        logger.warn({ provider: name, attempt }, 'LLM returned unparseable JSON');
        continue;
      }

      const validated = schema ? schema.safeParse(parsed.value) : { success: true, data: parsed.value };
      if (!validated.success) {
        lastIssue = validated.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        logger.warn({ provider: name, attempt, issue: lastIssue }, 'LLM output failed schema');
        continue;
      }

      return {
        data: validated.data,
        provider: raw.provider,
        model: raw.model,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        costUsd: estimateCostUsd(raw.model, raw.inputTokens, raw.outputTokens),
        attempts: attempt + 1,
        repairStage: parsed.stage,
        durationMs: Date.now() - started,
      };
    }

    if (lastIssue) failures.push(`${name}: ${lastIssue} (after ${maxRepairs + 1} attempts)`);
  }

  // Fail loudly. Never fabricate.
  throw new LlmError(
    LLM_ERROR.INVALID_JSON,
    `Generation failed after trying ${chain.map((e) => e.name).join(' then ')}. ${failures.join(' | ')}`,
    { failures, providers: chain.map((e) => e.name) },
  );
}

/**
 * Resolve the LLM function for a specific user (BYOK).
 *
 * If the user has an active, verified AI provider of their own, generation runs
 * on it, with the platform's env chain kept behind it as a fallback so a
 * transient failure of the user's key still completes. If they have none, this
 * returns the plain platform-key generateJSON. Resolve it ONCE at a pipeline
 * entry and inject the returned function wherever an agent takes `llm`; the deep
 * agent code never learns whose key it is.
 */
export async function resolveUserLlm({ userId } = {}) {
  const active = userId ? await getActiveProviderConfig({ userId }).catch(() => null) : null;
  if (!active) return generateJSON;

  // The user's provider is task-agnostic: they configured one model, used for
  // generation and explanation alike.
  const userEntry = {
    name: active.provider,
    model: active.model ?? active.config?.model ?? null,
    call: (opts) => callAiProvider({
      provider: active.provider,
      credentials: active.credentials,
      config: { ...active.config, model: opts.model ?? active.config?.model },
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      signal: opts.signal,
    }),
  };

  // Build the platform FALLBACK chain per call, honouring the task tier in opts
  // (generation vs the cheaper explanation tier), so a fallback still picks the
  // right platform model. The user's provider always leads.
  return (opts = {}) => {
    const task = opts.task ?? TASK.GENERATION;
    const envEntries = providerOrder().map((name) => ({ name, call: PROVIDERS[name], model: modelFor(task, name) }));
    return generateJSON({ ...opts, providerChain: [userEntry, ...envEntries] });
  };
}

export default {
  generateJSON, availableProviders, providerOrder, estimateCostUsd, resolveUserLlm,
};
