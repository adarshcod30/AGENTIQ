/**
 * A persisted permission grant.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §H, Phase 7. The permission gate (mcp/permissions.js)
 * keeps grants in memory so `check()` stays synchronous and fast. This model is
 * the write-through record behind it: it lets a grant survive a server restart
 * inside its own lifetime, which matters for a long assessment that outlives a
 * nodemon reload or a deploy.
 *
 * It does NOT weaken the rule that a grant must not outlive its session. The TTL
 * index below hands expiry to MongoDB: the document is deleted once `expiresAt`
 * passes, at the same one-hour horizon the in-memory store enforces. Persistence
 * survives a restart; it does not survive the clock.
 */
import mongoose from 'mongoose';

const grantSchema = new mongoose.Schema({
  // Stored as strings because the in-memory store keys buckets by
  // `${userId}::${sessionId}`, and a grant for one session must never be read
  // back for another. Matching that keying exactly is what keeps two concurrent
  // assessments from ever seeing each other's approvals.
  userId: { type: String, required: true },
  sessionId: { type: String, required: true },

  riskClass: { type: String, required: true },
  host: { type: String, default: null },
  confirmed: { type: Boolean, default: false },

  grantedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });

// The bucket lookup: everything for one session, read back on boot.
grantSchema.index({ userId: 1, sessionId: 1 });

// TTL: MongoDB deletes the document once expiresAt is in the past. This is what
// makes persistence safe. A grant that has expired is gone from the database on
// its own, with no sweep to run and nothing for a restart to resurrect.
grantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Grant =
  mongoose.models.Grant ?? mongoose.model('Grant', grantSchema, 'grants');
export default Grant;
