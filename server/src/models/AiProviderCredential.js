/**
 * A user's own credential for an AI generation provider (BYOK).
 *
 * Optional by design: a user who configures none falls back to the platform's
 * own keys. If they configure and activate one, their key overrides the
 * platform's for their own test generation. See [[byok-provider-settings]].
 *
 * The secret fields (an api key, or an access-key pair) are encrypted into
 * `secret` as one JSON blob with select:false, so they never leave on a normal
 * read. `config` holds the non-secret fields (region, model). `hints` holds the
 * last four characters of each secret, a harmless UI aid. The API only ever
 * exposes presence, config, hints and the verified flag, never the secret.
 */
import mongoose from 'mongoose';
import { AI_PROVIDER_NAMES } from '../services/ai-providers.js';

const aiProviderCredentialSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  provider: { type: String, enum: AI_PROVIDER_NAMES, required: true },
  /** Encrypted JSON of the secret fields. Never selected by default. */
  secret: { type: String, required: true, select: false },
  /** Non-secret fields: region, model, and the like. */
  config: { type: Map, of: String, default: undefined },
  /** Last-4 hints per secret field, e.g. { apiKey: 'ab12' }. */
  hints: { type: Map, of: String, default: undefined },
  verified: { type: Boolean, default: false },
  verifiedAt: { type: Date, default: null },
  /** The one provider this user's generation uses. At most one active per user. */
  active: { type: Boolean, default: false },
}, { timestamps: true });

aiProviderCredentialSchema.index({ userId: 1, provider: 1 }, { unique: true });

/** Presence + config only. The secret is never part of the JSON. */
aiProviderCredentialSchema.methods.toJSON = function toJSON() {
  const {
    provider, config, hints, verified, verifiedAt, active, updatedAt,
  } = this;
  return {
    provider,
    connected: true,
    config: config ? Object.fromEntries(config) : {},
    hints: hints ? Object.fromEntries(hints) : {},
    verified: Boolean(verified),
    verifiedAt: verifiedAt ?? null,
    active: Boolean(active),
    updatedAt,
  };
};

export const AiProviderCredential = mongoose.models.AiProviderCredential
  ?? mongoose.model('AiProviderCredential', aiProviderCredentialSchema);

export default AiProviderCredential;
