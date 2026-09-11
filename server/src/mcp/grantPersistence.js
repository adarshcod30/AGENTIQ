/**
 * Write-through persistence for the permission grant store.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §H, Phase 7. This is the seam between the
 * synchronous in-memory GrantStore (mcp/permissions.js) and MongoDB. It keeps
 * the permission gate free of any database import: the store calls hooks it was
 * handed, and this module is the only thing that knows those hooks talk to Mongo.
 *
 * Writes are fire-and-forget. A failure to persist a grant must never fail the
 * grant itself: the in-memory decision already stands, and the worst a dropped
 * write costs is that this one grant would not survive a restart. So every write
 * catches and logs rather than throwing into the request path.
 */
import { Grant } from '../models/Grant.js';
import { logger } from '../lib/logger.js';

/**
 * Builds a persistence object: `{ hydrate, hooks }`. `Model` is injectable so a
 * test can pass a fake and assert the writes without a database.
 */
export function makeGrantPersistence({ Model = Grant } = {}) {
  return {
    /** Load every unexpired grant into the store. Returns how many were loaded. */
    async hydrate(store) {
      const docs = await Model.find({ expiresAt: { $gt: new Date() } }).lean();
      return store.hydrate(docs.map((d) => ({
        userId: d.userId,
        sessionId: d.sessionId,
        riskClass: d.riskClass,
        host: d.host,
        confirmed: d.confirmed,
        grantedAt: new Date(d.grantedAt).getTime(),
        expiresAt: new Date(d.expiresAt).getTime(),
      })));
    },

    hooks: {
      onGrant({ userId, sessionId, entry }) {
        Model.create({
          userId: String(userId),
          sessionId: String(sessionId),
          riskClass: entry.riskClass,
          host: entry.host,
          confirmed: entry.confirmed,
          grantedAt: new Date(entry.grantedAt),
          expiresAt: new Date(entry.expiresAt),
        }).catch((err) => logger.warn({ err: err.message }, 'grant persist failed'));
      },

      onRevoke({ userId, sessionId, riskClass, host }) {
        const q = { userId: String(userId), sessionId: String(sessionId), riskClass };
        // A revoke with no host clears every host for the class; a revoke with a
        // host clears only that one. Mirror the in-memory filter exactly.
        if (host !== null && host !== undefined) q.host = host;
        Model.deleteMany(q).catch((err) => logger.warn({ err: err.message }, 'grant revoke persist failed'));
      },
    },
  };
}

/**
 * Wire persistence onto a store: load what survived, then start writing through.
 * Called once, after the database connects. Hydration failure is not fatal, the
 * server simply starts with no restored grants, so it is caught and logged.
 */
export async function attachGrantPersistence(store, { Model = Grant } = {}) {
  const persistence = makeGrantPersistence({ Model });
  try {
    const loaded = await persistence.hydrate(store);
    if (loaded > 0) logger.info({ loaded }, 'restored persisted permission grants');
  } catch (err) {
    logger.warn({ err: err.message }, 'grant hydration failed; starting with none');
  }
  store.setHooks(persistence.hooks);
  return persistence;
}

export default attachGrantPersistence;
