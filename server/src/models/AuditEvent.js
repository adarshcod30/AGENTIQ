/**
 * The audit collection, append-only by design.
 *
 * docs/02_TRD.md §5.3. Every tool invocation writes here, including denials and
 * SSRF blocks. This model and the Tool Registry page together are how the
 * project's central claim is *demonstrated* rather than asserted: you can watch
 * rows appear while a run executes.
 *
 * IMMUTABILITY IS STRUCTURAL, NOT A CONVENTION:
 *   - no update or delete route exists anywhere in the API
 *   - the schema below refuses updates at the mongoose layer too
 *
 * NEVER stores raw inputs. A probe payload can contain credentials the user
 * typed into the API client, so we store a SHA-256 of the canonicalised input
 * instead: enough to prove two calls were identical, useless to an attacker
 * who reads the collection.
 */
import mongoose from 'mongoose';

export const OUTCOME = {
  OK: 'ok',
  DENIED: 'denied',
  ERROR: 'error',
  BLOCKED_SSRF: 'blocked_ssrf',
  RATE_LIMITED: 'rate_limited',
};

export const OUTCOMES = Object.values(OUTCOME);

const auditEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    sessionId: { type: String },
    runId: { type: String, index: true },

    tool: { type: String, required: true, index: true },
    riskClass: { type: String, required: true },
    targetHost: { type: String, default: null },

    // sha256 of the canonicalised input, never the input itself.
    inputHash: { type: String, required: true },

    outcome: { type: String, required: true, enum: OUTCOMES, index: true },
    errorCode: { type: String, default: null },
    // Why a call was refused, in words a human can read.
    reason: { type: String, default: null },

    durationMs: { type: Number, default: 0 },
    ts: { type: Date, default: Date.now, index: true },
  },
  {
    // createdAt/updatedAt would imply mutability; `ts` is the only time here.
    timestamps: false,
    versionKey: false,
  },
);

auditEventSchema.index({ userId: 1, ts: -1 });
auditEventSchema.index({ runId: 1, ts: 1 });

/**
 * Refuse every mutation path at the model layer.
 *
 * Belt and braces: the API exposes no update or delete route, but a future
 * controller could import this model and call updateOne directly. Failing
 * loudly here means the append-only claim cannot quietly become untrue.
 */
const MUTATIONS = [
  'updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace',
  'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete',
];

for (const op of MUTATIONS) {
  // Registered explicitly as QUERY middleware. In Mongoose 7+ updateOne and
  // deleteOne are ambiguous: they exist as both document and query middleware,
  // and the two forms receive different arguments, which is why a `next`-style
  // hook fails with "next is not a function" on some of them. An async hook that
  // simply throws sidesteps the signature difference entirely.
  //
  // No escape hatch, deliberately: tests reset the collection through
  // AuditEvent.collection.deleteMany(), which is the native driver and bypasses
  // middleware by design. Leaving a NODE_ENV check here would be a mutation path
  // that exists in the shipped code, and the whole claim is that none does.
  auditEventSchema.pre(op, { query: true, document: false }, async function blockMutation() {
    throw new Error(`AuditEvent is append-only: ${op} is not permitted`);
  });
}

export const AuditEvent =
  mongoose.models.AuditEvent ?? mongoose.model('AuditEvent', auditEventSchema, 'auditevents');

export default AuditEvent;
