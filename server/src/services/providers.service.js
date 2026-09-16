/**
 * Per-user AI-provider credentials (BYOK): store, list (presence only), read
 * decrypted for the engine, verify, activate, remove. Owner-scoped throughout.
 *
 * A credential is verified with a live call before it can be activated, and only
 * the ACTIVE, verified provider is ever used for a user's generation. A user
 * with no active provider falls back to the platform's own keys.
 */
import { AiProviderCredential } from '../models/AiProviderCredential.js';
import {
  AI_PROVIDERS, AI_PROVIDER_NAMES, secretKeys, verifyAiProvider,
} from './ai-providers.js';
import { encryptSecret, decryptSecret, last4 } from './crypto.service.js';

export class ProviderError extends Error {
  constructor(message, code = 'PROVIDER_ERROR', status = 400) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
  }
}

function assertProvider(provider) {
  if (!AI_PROVIDER_NAMES.includes(provider)) {
    throw new ProviderError(`Unknown provider: ${provider}`, 'UNKNOWN_PROVIDER', 400);
  }
}

/** Split a flat fields object into { secrets, config }, applying field defaults. */
function partitionFields(provider, fields) {
  const spec = AI_PROVIDERS[provider];
  const secrets = {};
  const config = {};
  for (const f of spec.fields) {
    let value = fields?.[f.key];
    if ((value === undefined || value === '') && f.default !== undefined) value = f.default;
    if (f.required && (value === undefined || String(value).trim() === '')) {
      throw new ProviderError(`${f.label} is required for ${spec.label}.`, 'MISSING_FIELD', 400);
    }
    if (value === undefined || value === '') continue;
    if (f.type === 'secret') secrets[f.key] = String(value).trim();
    else config[f.key] = String(value).trim();
  }
  return { secrets, config };
}

/**
 * Store (or replace) a user's credential for a provider, verifying it first.
 * The credential is always stored (encrypted); `verified` reflects whether the
 * live check passed. If the user has no active provider yet and this one
 * verifies, it becomes active automatically.
 */
export async function setProviderCredential({ userId, provider, fields }) {
  assertProvider(provider);
  const { secrets, config } = partitionFields(provider, fields);

  const check = await verifyAiProvider({ provider, credentials: secrets, config });

  const hints = {};
  for (const k of secretKeys(provider)) if (secrets[k]) hints[k] = last4(secrets[k]);

  const activeCount = await AiProviderCredential.countDocuments({ userId, active: true });
  const makeActive = check.ok && activeCount === 0;

  await AiProviderCredential.findOneAndUpdate(
    { userId, provider },
    {
      $set: {
        secret: encryptSecret(JSON.stringify(secrets)),
        config,
        hints,
        verified: check.ok,
        verifiedAt: check.ok ? new Date() : null,
        ...(makeActive ? { active: true } : {}),
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  return { provider, connected: true, verified: check.ok, active: makeActive, error: check.ok ? null : check.error };
}

/** Presence + config for every provider. Never a secret. */
export async function listProviderCredentials({ userId }) {
  const rows = await AiProviderCredential.find({ userId });
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return AI_PROVIDER_NAMES.map((provider) => {
    const row = byProvider.get(provider);
    return row
      ? row.toJSON()
      : { provider, connected: false, config: {}, hints: {}, verified: false, verifiedAt: null, active: false };
  });
}

/** The field spec, for the UI to render the right inputs per provider. */
export function providerSpecs() {
  return AI_PROVIDER_NAMES.map((provider) => ({
    provider,
    label: AI_PROVIDERS[provider].label,
    fields: AI_PROVIDERS[provider].fields.map((f) => ({
      key: f.key, label: f.label, type: f.type, required: Boolean(f.required),
      placeholder: f.placeholder ?? null, default: f.default ?? null,
    })),
  }));
}

/**
 * Re-verify a stored credential with a live call and update its verified flag.
 * If an active provider stops verifying, it is deactivated so generation falls
 * back to the platform keys cleanly rather than failing every call.
 */
export async function testProviderCredential({ userId, provider }) {
  assertProvider(provider);
  const row = await AiProviderCredential.findOne({ userId, provider }).select('+secret');
  if (!row) throw new ProviderError('That provider is not configured.', 'NOT_CONFIGURED', 404);
  let secrets;
  try {
    secrets = JSON.parse(decryptSecret(row.secret));
  } catch {
    throw new ProviderError('The stored credential could not be read; re-enter it.', 'DECRYPT_FAILED', 400);
  }
  const config = row.config ? Object.fromEntries(row.config) : {};
  const check = await verifyAiProvider({ provider, credentials: secrets, config });
  row.verified = check.ok;
  row.verifiedAt = check.ok ? new Date() : null;
  if (!check.ok && row.active) row.active = false;
  await row.save();
  return { provider, verified: check.ok, active: row.active, error: check.ok ? null : check.error };
}

/** Make one verified provider active, and deactivate the rest. */
export async function setActiveProvider({ userId, provider }) {
  assertProvider(provider);
  const row = await AiProviderCredential.findOne({ userId, provider });
  if (!row) throw new ProviderError('That provider is not configured.', 'NOT_CONFIGURED', 404);
  if (!row.verified) throw new ProviderError('Verify the provider before making it active.', 'NOT_VERIFIED', 400);
  await AiProviderCredential.updateMany({ userId }, { $set: { active: false } });
  await AiProviderCredential.updateOne({ userId, provider }, { $set: { active: true } });
  return { provider, active: true };
}

/** Turn off BYOK for a user: nothing active, so generation uses platform keys. */
export async function clearActiveProvider({ userId }) {
  await AiProviderCredential.updateMany({ userId }, { $set: { active: false } });
  return { active: null };
}

export async function removeProviderCredential({ userId, provider }) {
  assertProvider(provider);
  await AiProviderCredential.deleteOne({ userId, provider });
  return { provider, connected: false };
}

/**
 * The active, verified provider with DECRYPTED credentials, for the engine.
 * Returns null when the user has no active provider (fall back to platform
 * keys) or when the stored secret can no longer be decrypted.
 */
export async function getActiveProviderConfig({ userId }) {
  const row = await AiProviderCredential.findOne({ userId, active: true, verified: true }).select('+secret');
  if (!row) return null;
  let secrets;
  try {
    secrets = JSON.parse(decryptSecret(row.secret));
  } catch {
    return null;
  }
  const config = row.config ? Object.fromEntries(row.config) : {};
  return { provider: row.provider, credentials: secrets, config, model: config.model ?? null };
}

export default {
  setProviderCredential, listProviderCredentials, providerSpecs, testProviderCredential,
  setActiveProvider, clearActiveProvider, removeProviderCredential, getActiveProviderConfig,
};
