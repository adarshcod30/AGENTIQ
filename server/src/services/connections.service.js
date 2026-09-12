/**
 * Per-user third-party connections: store, list (presence only), read the token
 * server-side for a deploy or a clone, and remove. Owner-scoped throughout.
 */
import { Connection, CONNECTION_PROVIDERS } from '../models/Connection.js';
import { encryptSecret, decryptSecret, last4 } from './crypto.service.js';

export class ConnectionError extends Error {
  constructor(message, code = 'CONNECTION_ERROR', status = 400) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
    this.status = status;
  }
}

function assertProvider(provider) {
  if (!CONNECTION_PROVIDERS.includes(provider)) {
    throw new ConnectionError(`Unknown provider: ${provider}`, 'UNKNOWN_PROVIDER', 400);
  }
}

/** Store (or replace) a user's token for a provider. Encrypted at rest. */
export async function setConnection({ userId, provider, token }) {
  assertProvider(provider);
  const t = String(token ?? '').trim();
  if (t.length < 8) throw new ConnectionError('That token looks too short to be valid.', 'BAD_TOKEN', 400);
  const secret = encryptSecret(t);
  await Connection.findOneAndUpdate(
    { userId, provider },
    { $set: { secret, last4: last4(t), authType: 'token' } },
    { upsert: true, setDefaultsOnInsert: true },
  );
  return { provider, connected: true, last4: last4(t) };
}

/** Presence only: every provider with connected true/false. Never a token. */
export async function listConnections({ userId }) {
  const rows = await Connection.find({ userId }).lean();
  return CONNECTION_PROVIDERS.map((provider) => {
    const row = rows.find((r) => r.provider === provider);
    return row
      ? { provider, connected: true, last4: row.last4 ?? null, authType: row.authType ?? 'token', updatedAt: row.updatedAt }
      : { provider, connected: false, last4: null, authType: 'token' };
  });
}

/**
 * The decrypted token, for server-side use only (a deploy or a private clone).
 * Returns null when not connected, or when the stored value can no longer be
 * decrypted (JWT_SECRET was rotated): the caller then treats it as not connected.
 */
export async function getConnectionToken({ userId, provider }) {
  assertProvider(provider);
  const row = await Connection.findOne({ userId, provider }).select('+secret');
  if (!row) return null;
  try {
    return decryptSecret(row.secret);
  } catch {
    return null;
  }
}

export async function removeConnection({ userId, provider }) {
  assertProvider(provider);
  await Connection.deleteOne({ userId, provider });
  return { provider, connected: false };
}

export default { setConnection, listConnections, getConnectionToken, removeConnection };
