/**
 * Dashboard aggregates: docs/01_PRD.md F6.
 *
 * The acceptance criterion is blunt: a brand-new account shows honest zeros and
 * a call to action, and every number traces to a query. These tests exist to
 * prove the numbers are computed, not typed into the component tree.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { getStats, PULSE_DAYS } from '../src/services/stats.service.js';
import { TestRun } from '../src/models/TestRun.js';
import { AuditEvent } from '../src/models/AuditEvent.js';
import { User } from '../src/models/User.js';
import { createApp } from '../src/app.js';

const app = createApp({ logging: false });
let user;
let token;

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

beforeEach(async () => {
  await User.deleteMany({});
  await TestRun.deleteMany({});
  await AuditEvent.collection.deleteMany({});
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Stats', email: 'stats@example.com',
    password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  token = res.body.data.token;
  user = await User.findOne({ email: 'stats@example.com' });
});

/** Builds a completed run with the given shape. */
async function seedRun({
  passed = 0, failed = 0, discarded = 0, findings = [], daysAgo = 0,
  state = 'COMPLETE', latencies = [],
} = {}) {
  const startedAt = new Date();
  startedAt.setUTCDate(startedAt.getUTCDate() - daysAgo);
  return TestRun.create({
    userId: user._id,
    state,
    target: { url: 'https://api.test/users', method: 'GET', description: 'seed' },
    summary: { totalTests: passed + failed, passed, failed, discarded },
    functional: latencies.map((ms, i) => ({
      name: `t${i}`, status: 'pass', responseTimeMs: ms, assertions: [],
    })),
    security: findings,
    generation: { inputTokens: 100, outputTokens: 200, costUsd: 0.0001 },
    startedAt,
    finishedAt: startedAt,
  });
}

describe('a brand-new account shows HONEST ZEROS', () => {
  it('returns zeros, not invented data', async () => {
    const stats = await getStats({ userId: user._id });
    expect(stats.totals.totalRuns).toBe(0);
    expect(stats.totals.testsExecuted).toBe(0);
    expect(stats.totalFindings).toBe(0);
    expect(stats.recent).toEqual([]);
  });

  it('reports passRate as NULL, not 0: "no data" is not "0% pass"', async () => {
    // A dashboard showing 0% for an account that has never run anything is a
    // lie of a different kind. null lets the UI render a dash.
    const stats = await getStats({ userId: user._id });
    expect(stats.totals.passRate).toBeNull();
    expect(stats.totals.medianLatencyMs).toBeNull();
  });

  it('still returns a full 14-day pulse, zero-filled', async () => {
    // A $group alone returns only days WITH data, which silently compresses
    // gaps: three runs in two weeks would look like three busy days.
    const stats = await getStats({ userId: user._id });
    expect(stats.pulse).toHaveLength(PULSE_DAYS);
    expect(stats.pulse.every((d) => d.passed === 0 && d.failed === 0)).toBe(true);
    expect(stats.pulse.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);
  });
});

describe('totals are computed from real runs', () => {
  it('sums tests across runs and derives a pass rate', async () => {
    await seedRun({ passed: 3, failed: 1 });
    await seedRun({ passed: 4, failed: 0 });
    const stats = await getStats({ userId: user._id });

    expect(stats.totals.totalRuns).toBe(2);
    expect(stats.totals.testsExecuted).toBe(8);
    expect(stats.totals.testsPassed).toBe(7);
    expect(stats.totals.passRate).toBe(87.5);
  });

  it('surfaces discarded cases rather than hiding them', async () => {
    await seedRun({ passed: 2, failed: 0, discarded: 3 });
    expect((await getStats({ userId: user._id })).totals.discarded).toBe(3);
  });

  it('counts failed runs separately from failed tests', async () => {
    await seedRun({ state: 'GEN_FAILED' });
    await seedRun({ passed: 1, failed: 1 });
    const stats = await getStats({ userId: user._id });
    expect(stats.totals.failedRuns).toBe(1);
    expect(stats.totals.testsFailed).toBe(1);
  });

  it('computes a median latency across executed cases', async () => {
    await seedRun({ latencies: [10, 20, 30] });
    expect((await getStats({ userId: user._id })).totals.medianLatencyMs).toBe(20);
  });

  it('accumulates tokens and cost for the evaluation cost column', async () => {
    await seedRun({ passed: 1 });
    await seedRun({ passed: 1 });
    const stats = await getStats({ userId: user._id });
    expect(stats.totals.tokensUsed).toBe(600);
    expect(stats.totals.costUsd).toBeCloseTo(0.0002, 5);
  });
});

describe('findings by severity', () => {
  it('counts across every run', async () => {
    const f = (severity) => ({
      family: 'sqli', owasp: 'API8:2023', severity, vulnerable: true,
      payload: 'p', signal: 's', baseline: 'b', explanation: 'e', remediation: 'r',
    });
    await seedRun({ findings: [f('critical'), f('high'), f('high')] });
    await seedRun({ findings: [f('low')] });

    const stats = await getStats({ userId: user._id });
    expect(stats.findings).toEqual({ critical: 1, high: 2, medium: 0, low: 1 });
    expect(stats.totalFindings).toBe(4);
  });
});

describe('the 14-day pulse', () => {
  it('places runs on the correct day and leaves the rest at zero', async () => {
    await seedRun({ passed: 2, failed: 1, daysAgo: 0 });
    await seedRun({ passed: 5, failed: 0, daysAgo: 3 });

    const stats = await getStats({ userId: user._id });
    expect(stats.pulse).toHaveLength(PULSE_DAYS);
    expect(stats.pulse.at(-1)).toMatchObject({ passed: 2, failed: 1, runs: 1 });
    expect(stats.pulse.at(-4)).toMatchObject({ passed: 5, failed: 0, runs: 1 });
    expect(stats.pulse.filter((d) => d.runs === 0)).toHaveLength(PULSE_DAYS - 2);
  });

  it('excludes runs older than the window', async () => {
    await seedRun({ passed: 9, daysAgo: 40 });
    const stats = await getStats({ userId: user._id });
    expect(stats.pulse.reduce((n, d) => n + d.passed, 0)).toBe(0);
    // ...but the run still counts in the all-time totals.
    expect((await getStats({ userId: user._id })).totals.totalRuns).toBe(1);
  });
});

describe('scoping', () => {
  it('never counts another user runs', async () => {
    const other = await User.create({
      email: 'other@example.com', displayName: 'Other',
      authProviders: [{ provider: 'local', providerId: 'o', email: 'other@example.com' }],
    });
    await TestRun.create({
      userId: other._id, target: { url: 'https://theirs.test' },
      summary: { totalTests: 99, passed: 99, failed: 0, discarded: 0 },
    });
    const stats = await getStats({ userId: user._id });
    expect(stats.totals.totalRuns).toBe(0);
    expect(stats.totals.testsExecuted).toBe(0);
  });
});

describe('GET /api/runs/stats', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/runs/stats')).status).toBe(401);
  });

  it('is not shadowed by the /:id route', async () => {
    // Express matches in order; with /:id first, "stats" would be read as an id.
    const res = await request(app).get('/api/runs/stats').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('pulse');
  });

  it('returns audit counters, so the dashboard can show the tool layer is live', async () => {
    await AuditEvent.create({
      userId: user._id, tool: 'http_request', riskClass: 'network.read',
      inputHash: 'a'.repeat(64), outcome: 'blocked_ssrf',
    });
    const res = await request(app).get('/api/runs/stats').set('Authorization', `Bearer ${token}`);
    expect(res.body.data.audit.blocked_ssrf).toBe(1);
  });
});
