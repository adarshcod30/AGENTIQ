/**
 * The BYOK AI-provider registry.
 *
 * Each user may bring their own credentials for one of these providers and use
 * it for test generation instead of the platform's own keys. This file holds
 * three things and nothing about storage or HTTP routing:
 *
 *   1. AI_PROVIDERS  the field spec per provider, so the UI can render exactly
 *                    the inputs that provider needs (a key, a region, a model),
 *                    and the server can validate them.
 *   2. callAiProvider  one generation call, dispatched by provider. Returns the
 *                    same { text, provider, model, inputTokens, outputTokens }
 *                    shape the env-based providers in llm.js return, so it drops
 *                    straight into generateJSON's chain.
 *   3. verifyAiProvider  a tiny live call used to prove a credential works
 *                    before it is trusted.
 *
 * The provider endpoints are FIXED per provider (never user-supplied), so a
 * direct request carries no SSRF risk: there is no user-controlled host here.
 */
import axios from 'axios';

/** field: { key, label, type: 'secret' | 'text', required, default?, placeholder?, help? } */
export const AI_PROVIDERS = {
  bedrock: {
    label: 'AWS Bedrock',
    modelField: 'model',
    fields: [
      { key: 'accessKeyId', label: 'Access key ID', type: 'secret', required: true },
      { key: 'secretAccessKey', label: 'Secret access key', type: 'secret', required: true },
      { key: 'region', label: 'Region', type: 'text', required: true, default: 'ap-south-1' },
      { key: 'model', label: 'Model ID', type: 'text', required: true, placeholder: 'deepseek.v3.2', default: 'deepseek.v3.2' },
    ],
  },
  openai: {
    label: 'OpenAI',
    modelField: 'model',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, placeholder: 'sk-…' },
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'gpt-4o-mini', default: 'gpt-4o-mini' },
    ],
  },
  anthropic: {
    label: 'Anthropic',
    modelField: 'model',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, placeholder: 'sk-ant-…' },
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'claude-3-5-haiku-latest', default: 'claude-3-5-haiku-latest' },
    ],
  },
  gemini: {
    label: 'Google Gemini',
    modelField: 'model',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, placeholder: 'AIza…' },
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'gemini-1.5-flash', default: 'gemini-1.5-flash' },
    ],
  },
  xai: {
    label: 'xAI (Grok)',
    modelField: 'model',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, placeholder: 'xai-…' },
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'grok-2-latest', default: 'grok-2-latest' },
    ],
  },
  groq: {
    label: 'Groq',
    modelField: 'model',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, placeholder: 'gsk_…' },
      { key: 'model', label: 'Model', type: 'text', required: true, placeholder: 'openai/gpt-oss-120b', default: 'openai/gpt-oss-120b' },
    ],
  },
};

export const AI_PROVIDER_NAMES = Object.keys(AI_PROVIDERS);

/** Which keys of a provider's fields are secret (encrypted at rest). */
export function secretKeys(provider) {
  return (AI_PROVIDERS[provider]?.fields ?? []).filter((f) => f.type === 'secret').map((f) => f.key);
}

/** The public (non-secret) config keys: region, model, and the like. */
export function configKeys(provider) {
  return (AI_PROVIDERS[provider]?.fields ?? []).filter((f) => f.type !== 'secret').map((f) => f.key);
}

export class AiProviderError extends Error {
  constructor(message, code = 'AI_PROVIDER_ERROR') {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
  }
}

// ── OpenAI-compatible chat completions (OpenAI, xAI, Groq) ───────────────────

const OPENAI_COMPATIBLE = {
  openai: 'https://api.openai.com/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
};

// Reasoning models spend output tokens THINKING before they answer, so a tiny
// max_tokens leaves the answer empty. Ask for low reasoning effort where the
// API supports it. (Kept local to avoid importing llm.js, which imports this.)
const REASONING_MODELS = /gpt-oss|qwen3|o1|o3|deepseek-r|reason/i;
const isReasoning = (model) => REASONING_MODELS.test(String(model ?? ''));

async function callOpenAiCompatible(provider, { system, prompt, maxTokens, temperature, model, apiKey, signal }) {
  // No response_format: json_object here. Some models (reasoning models on Groq
  // among them) reject or fail strict JSON mode, and generateJSON already parses
  // loosely and repairs, which is exactly how the Bedrock path works. Relying on
  // that keeps all providers working rather than only the ones with clean JSON mode.
  const res = await axios.post(
    OPENAI_COMPATIBLE[provider],
    {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
      ...(isReasoning(model) ? { reasoning_effort: 'low' } : {}),
    },
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 60_000, signal },
  );
  const usage = res.data?.usage ?? {};
  return {
    text: res.data?.choices?.[0]?.message?.content ?? '',
    provider,
    model,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
}

// ── Anthropic Messages API ───────────────────────────────────────────────────

async function callAnthropic({ system, prompt, maxTokens, temperature, model, apiKey, signal }) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    },
    {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 60_000,
      signal,
    },
  );
  const usage = res.data?.usage ?? {};
  const text = (res.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, provider: 'anthropic', model, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
}

// ── Google Gemini generateContent ────────────────────────────────────────────

async function callGemini({ system, prompt, maxTokens, temperature, model, apiKey, signal }) {
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    },
    { headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' }, timeout: 60_000, signal },
  );
  const cand = res.data?.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const usage = res.data?.usageMetadata ?? {};
  return {
    text,
    provider: 'gemini',
    model,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
}

// ── Bedrock Converse with per-user credentials ───────────────────────────────

async function callBedrockByok({ system, prompt, maxTokens, temperature, model, accessKeyId, secretAccessKey, region }) {
  const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({
    region: region || 'ap-south-1',
    credentials: { accessKeyId, secretAccessKey },
  });
  const res = await client.send(new ConverseCommand({
    modelId: model,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens, temperature },
  }));
  return {
    text: res.output?.message?.content?.[0]?.text ?? '',
    provider: 'bedrock',
    model,
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
  };
}

/**
 * One generation call for a BYOK provider. `credentials` holds the secret fields
 * (apiKey, or accessKeyId/secretAccessKey); `config` holds region/model. The
 * error message is normalised so a bad key reads clearly rather than leaking a
 * raw provider response.
 */
export async function callAiProvider({ provider, credentials = {}, config = {}, system, prompt, maxTokens = 2048, temperature = 0.2, signal }) {
  const model = config.model;
  try {
    switch (provider) {
      case 'openai':
      case 'xai':
      case 'groq':
        return await callOpenAiCompatible(provider, { system, prompt, maxTokens, temperature, model, apiKey: credentials.apiKey, signal });
      case 'anthropic':
        return await callAnthropic({ system, prompt, maxTokens, temperature, model, apiKey: credentials.apiKey, signal });
      case 'gemini':
        return await callGemini({ system, prompt, maxTokens, temperature, model, apiKey: credentials.apiKey, signal });
      case 'bedrock':
        return await callBedrockByok({
          system, prompt, maxTokens, temperature, model,
          accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, region: config.region,
        });
      default:
        throw new AiProviderError(`Unknown provider: ${provider}`, 'UNKNOWN_PROVIDER');
    }
  } catch (err) {
    const detail = err.response?.data?.error?.message
      ?? err.response?.data?.error
      ?? err.name
      ?? err.message;
    throw new AiProviderError(
      `${AI_PROVIDERS[provider]?.label ?? provider} request failed: ${typeof detail === 'string' ? detail.slice(0, 200) : err.message}`,
      'PROVIDER_CALL_FAILED',
    );
  }
}

/**
 * Prove a credential works with one tiny call. Returns { ok, model } on success
 * or { ok:false, error } on failure, never throwing, so the route can turn it
 * straight into a response.
 */
export async function verifyAiProvider({ provider, credentials, config }) {
  try {
    // A lenient probe: it only proves the credential authenticates and the model
    // answers. It does NOT require JSON, so a reasoning model that pads its reply
    // still verifies. Real generation is validated by generateJSON, not here.
    const out = await callAiProvider({
      provider, credentials, config,
      system: 'You are a health check. Reply with the single word OK.',
      prompt: 'Reply with OK.',
      maxTokens: 256,
      temperature: 0,
    });
    return { ok: Boolean(out.text && out.text.trim().length), model: config.model };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { AI_PROVIDERS, AI_PROVIDER_NAMES, callAiProvider, verifyAiProvider, secretKeys, configKeys };
