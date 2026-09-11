/**
 * Failure explanations, with per-run state by design.
 *
 * The obvious implementation keeps an "explanation used" flag at module scope.
 * Set on the first explained failure and never reset, it makes explanations
 * fire **once per server process**: the first user to hit a failing test gets
 * one and nobody else does until a restart.
 *
 * Here the state lives in an object created per run (`createExplainBudget()`),
 * so there is no module-level variable that CAN leak across runs. Bringing the
 * bug back would mean deliberately adding module state.
 *
 * EXPLAINING is best-effort (docs/03_App_Flow.md B7): it is time-boxed and may
 * never block completion. A run that finishes without explanations is still a
 * complete, valid run.
 */
import { generateJSON, providerOrder, TASK } from './llm.js';
import { logger } from '../lib/logger.js';

/** docs/03_App_Flow.md B7: EXPLAINING is best-effort with a 5s timeout. */
export const EXPLAIN_TIMEOUT_MS = 5_000;

/** Explaining every one of 12 failures would dominate a run's latency and cost. */
export const DEFAULT_MAX_EXPLANATIONS = 3;

const explanationSchema = {
  safeParse(value) {
    const text = typeof value?.explanation === 'string' ? value.explanation.trim() : null;
    if (!text) {
      return { success: false, error: { issues: [{ path: ['explanation'], message: 'missing' }] } };
    }
    return { success: true, data: { explanation: text.slice(0, 600) } };
  },
};

/**
 * Per-run budget, created fresh for every run. Nothing here is module state.
 */
export function createExplainBudget({ max = DEFAULT_MAX_EXPLANATIONS } = {}) {
  return { max, used: 0, remaining() { return this.max - this.used; } };
}

const SYSTEM = 'You explain why an API test failed, for a developer. ' +
  'Reply ONLY as {"explanation": "..."}: two sentences, plain English, no markdown.';

function buildPrompt(result, target) {
  const failed = (result.assertions ?? []).filter((a) => !a.pass);
  return [
    `Endpoint: ${target.method} ${target.url}`,
    `Test: ${result.name}`,
    result.intent ? `Intent: ${result.intent}` : '',
    `HTTP status: ${result.httpStatus ?? 'no response'}`,
    result.error ? `Transport error: ${result.error}` : '',
    '',
    'Failed assertions:',
    ...failed.map((a) => `  - ${a.kind}: expected ${a.expected}, actual ${a.actual}`),
    '',
    'In two sentences: what does this indicate about the endpoint, and what should the developer check?',
  ].filter(Boolean).join('\n');
}

/** Races a promise against a timeout. Never rejects: returns null instead. */
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Explains one failing result. Returns null if unavailable, over budget, or slow.
 * NEVER throws: an explanation failure must not fail a run.
 */
export async function explainFailure({
  result, target, budget, llm = generateJSON, timeoutMs = EXPLAIN_TIMEOUT_MS,
}) {
  if (!budget || budget.used >= budget.max) return null;

  // Skip the round trip when nothing is configured, but ONLY for the default
  // provider. An explicitly injected llm IS the provider, so checking global
  // configuration for it would make the function untestable and would ignore a
  // caller who supplied a working one.
  if (llm === generateJSON && providerOrder().length === 0) return null;

  budget.used += 1;

  const outcome = await withTimeout(
    llm({
      system: SYSTEM,
      prompt: buildPrompt(result, target),
      schema: explanationSchema,
      maxTokens: 200,
      // Cheapest, fastest tier: this is short prose, not structured output.
      task: TASK.EXPLANATION,
      temperature: 0.3,
      maxRepairs: 0, // best-effort; do not spend a retry on a nicety
    }).catch((err) => {
      logger.debug({ err: err.message }, 'explanation unavailable');
      return null;
    }),
    timeoutMs,
  );

  return outcome?.data?.explanation ?? null;
}

/**
 * Explains the failures in a run, in place, within one shared per-run budget.
 * Returns how many explanations were produced.
 */
export async function explainRunFailures({ results, target, budget, llm, timeoutMs }) {
  const failures = results.filter((r) => r.status === 'fail' || r.status === 'error');
  let produced = 0;

  for (const result of failures) {
    if (budget.used >= budget.max) break;
    const explanation = await explainFailure({ result, target, budget, llm, timeoutMs });
    if (explanation) {
      result.explanation = explanation;
      produced += 1;
    }
  }

  return produced;
}

export default { explainRunFailures, createExplainBudget };
