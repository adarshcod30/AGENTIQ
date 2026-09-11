/**
 * Persistent permission grants (Phase 7).
 *
 * The in-memory store stays the source of truth; these tests prove the
 * write-through record behind it behaves: a grant survives a "restart"
 * (a fresh store that re-hydrates from Mongo), an expired grant is never
 * restored, a revoke is erased, and two sessions never read each other's
 * grants back, which is the concurrency-isolation guarantee Phase 7 exists for.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { GrantStore, RISK_CLASS } from '../src/mcp/permissions.js';
import { makeGrantPersistence, attachGrantPersistence } from '../src/mcp/grantPersistence.js';
import { Grant } from '../src/models/Grant.js';

/** A grant persists asynchronously; wait until the row lands (or time out). */
async function waitForRows(filter, n, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (await Grant.countDocuments(filter) >= n) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** The mirror: wait until every matching row is gone (a revoke completed). */
async function waitForGone(filter, tries = 50) {
  for (let i = 0; i < tries; i += 1) {
    if (await Grant.countDocuments(filter) === 0) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe('grant persistence', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });
  beforeEach(async () => { await Grant.deleteMany({}); });

  it('writes a grant through to the database', async () => {
    const store = new GrantStore();
    store.setHooks(makeGrantPersistence().hooks);

    store.grant({ userId: 'u1', sessionId: 'assessment:a1', riskClass: RISK_CLASS.NETWORK_READ, host: 'example.com' });

    expect(await waitForRows({ userId: 'u1' }, 1)).toBe(true);
    const doc = await Grant.findOne({ userId: 'u1' }).lean();
    expect(doc.sessionId).toBe('assessment:a1');
    expect(doc.host).toBe('example.com');
    expect(doc.riskClass).toBe(RISK_CLASS.NETWORK_READ);
  });

  it('restores an unexpired grant into a fresh store, so a restart keeps it', async () => {
    const first = new GrantStore();
    await attachGrantPersistence(first);
    first.grant({ userId: 'u2', sessionId: 's2', riskClass: RISK_CLASS.NETWORK_READ, host: 'api.test' });
    expect(await waitForRows({ userId: 'u2' }, 1)).toBe(true);

    // A brand-new store is the "after restart" world: empty until it hydrates.
    const restarted = new GrantStore();
    expect(restarted.check({ userId: 'u2', sessionId: 's2', riskClass: RISK_CLASS.NETWORK_READ, host: 'api.test' }).allowed).toBe(false);

    await attachGrantPersistence(restarted);
    expect(restarted.check({ userId: 'u2', sessionId: 's2', riskClass: RISK_CLASS.NETWORK_READ, host: 'api.test' }).allowed).toBe(true);
  });

  it('never restores a grant that has already expired', async () => {
    // A grant written straight to the collection with an expiry in the past.
    await Grant.create({
      userId: 'u3', sessionId: 's3', riskClass: RISK_CLASS.NETWORK_READ, host: 'stale.test',
      confirmed: false, grantedAt: new Date(Date.now() - 7200_000), expiresAt: new Date(Date.now() - 3600_000),
    });
    const store = new GrantStore();
    const loaded = await makeGrantPersistence().hydrate(store);
    expect(loaded).toBe(0);
    expect(store.check({ userId: 'u3', sessionId: 's3', riskClass: RISK_CLASS.NETWORK_READ, host: 'stale.test' }).allowed).toBe(false);
  });

  it('erases a revoked grant, so it does not come back on the next restart', async () => {
    const store = new GrantStore();
    store.setHooks(makeGrantPersistence().hooks);
    store.grant({ userId: 'u4', sessionId: 's4', riskClass: RISK_CLASS.NETWORK_READ, host: 'gone.test' });
    expect(await waitForRows({ userId: 'u4' }, 1)).toBe(true);

    store.revoke({ userId: 'u4', sessionId: 's4', riskClass: RISK_CLASS.NETWORK_READ, host: 'gone.test' });
    expect(await waitForGone({ userId: 'u4' })).toBe(true);

    const restarted = new GrantStore();
    await attachGrantPersistence(restarted);
    expect(restarted.check({ userId: 'u4', sessionId: 's4', riskClass: RISK_CLASS.NETWORK_READ, host: 'gone.test' }).allowed).toBe(false);
  });

  it('keeps two sessions isolated: one session cannot read the other back', async () => {
    const store = new GrantStore();
    store.setHooks(makeGrantPersistence().hooks);
    // Two concurrent assessments of two different projects, same user.
    store.grant({ userId: 'u5', sessionId: 'assessment:A', riskClass: RISK_CLASS.NETWORK_READ, host: '127.0.0.1:4001' });
    store.grant({ userId: 'u5', sessionId: 'assessment:B', riskClass: RISK_CLASS.NETWORK_READ, host: '127.0.0.1:4002' });
    expect(await waitForRows({ userId: 'u5' }, 2)).toBe(true);

    const restarted = new GrantStore();
    await attachGrantPersistence(restarted);

    // A's host is granted for A and denied for B, and vice versa.
    expect(restarted.check({ userId: 'u5', sessionId: 'assessment:A', riskClass: RISK_CLASS.NETWORK_READ, host: '127.0.0.1:4001' }).allowed).toBe(true);
    expect(restarted.check({ userId: 'u5', sessionId: 'assessment:B', riskClass: RISK_CLASS.NETWORK_READ, host: '127.0.0.1:4001' }).allowed).toBe(false);
    expect(restarted.check({ userId: 'u5', sessionId: 'assessment:B', riskClass: RISK_CLASS.NETWORK_READ, host: '127.0.0.1:4002' }).allowed).toBe(true);
    expect(restarted.check({ userId: 'u5', sessionId: 'assessment:A', riskClass: RISK_CLASS.NETWORK_READ, host: '127.0.0.1:4002' }).allowed).toBe(false);
  });

  it('a write failure never throws into the caller', async () => {
    // A fake model whose create rejects: the grant must still be recorded in
    // memory and check() must still allow it.
    const failing = { create: () => Promise.reject(new Error('db down')), deleteMany: () => Promise.reject(new Error('db down')) };
    const store = new GrantStore();
    store.setHooks(makeGrantPersistence({ Model: failing }).hooks);

    expect(() => store.grant({ userId: 'u6', sessionId: 's6', riskClass: RISK_CLASS.NETWORK_READ, host: 'h' })).not.toThrow();
    expect(store.check({ userId: 'u6', sessionId: 's6', riskClass: RISK_CLASS.NETWORK_READ, host: 'h' }).allowed).toBe(true);
  });
});
