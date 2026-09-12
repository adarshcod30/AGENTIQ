/**
 * Connection: a user's stored credential for a third-party service they bring
 * themselves (their own GitHub, Render or Vercel account). AGENTIQ is
 * multi-tenant, so deploys and private-repo clones use the CURRENT user's own
 * token, never a shared platform key.
 *
 * The token is encrypted at rest (services/crypto.service.js) and stored in
 * `secret` with select:false, so it never leaves on a normal read. The API only
 * ever exposes presence, the provider, and the last four characters. `authType`
 * is 'token' today and leaves room for 'oauth' later without a schema change.
 */
import mongoose from 'mongoose';

export const CONNECTION_PROVIDERS = ['github', 'render', 'vercel'];

const connectionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: CONNECTION_PROVIDERS, required: true },
  authType: { type: String, enum: ['token', 'oauth'], default: 'token' },
  /** The encrypted API token. Never selected by default, never returned. */
  secret: { type: String, required: true, select: false },
  /** Last 4 characters of the token, a harmless hint for the UI. */
  last4: { type: String, default: null },
}, { timestamps: true });

// One connection per provider per user; setting a token upserts this row.
connectionSchema.index({ userId: 1, provider: 1 }, { unique: true });

/** Presence only. The secret is never part of the JSON. */
connectionSchema.methods.toJSON = function toJSON() {
  const { provider, authType, last4, updatedAt } = this;
  return { provider, authType: authType ?? 'token', connected: true, last4: last4 ?? null, updatedAt };
};

export const Connection = mongoose.models.Connection ?? mongoose.model('Connection', connectionSchema);
export default Connection;
