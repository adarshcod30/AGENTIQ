/**
 * Run lifecycle: the state machine in docs/03_App_Flow.md B7.
 *
 * Two rules are asserted repeatedly here because they are the easiest to break:
 *   1. EVERY terminal state persists a TestRun. A failed run is data, not a void.
 *   2. EXPLAINING never blocks completion, and its budget is PER RUN.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { startRun, listRuns, getRun, transition } from '../src/services/run.service.js';
import { TestRun, RUN_STATE, canTransition, TERMINAL_STATES } from '../src/models/TestRun.js';
import { createExplainBudget, explainRunFailures } from '../src/services/explain.service.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { grantStore, RISK_CLASS } from '../src/mcp/permissions.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { env } from '../src/config/env.js';
import { app as hardenedApp } from '../../fixtures/hardened-api/server.js';

const app = createApp({ logging: false });
let user;
let token;
let fixtureUrl;
let fixtureServer;

const CASES = [
  {
    name: 'Fetch user 1', intent: 'happy path', method: 'GET', path: 'users/1',
    headers: {}, category: 'positive',
    assertions: [{ kind: 'status', expected: 200 }],
  },
  {
    name: 'Deliberately wrong', intent: 'forced failure', method: 'GET', path: 'users/1',
    headers: {}, category: 'negative',
    assertions: [{ kind: 'status', expected: 418 }],
  },
];

const stubLlm = (cases) => async ({ schema }) => ({
  data: schema.parse({ cases }),
  provider: 'stub', model: 'stub-1',
  inputTokens: 50, outputTokens: 90, costUsd: 0.00005,
  attempts: 1, repairStage: 'direct', durationMs: 2,
});

const failingLlm = async () => {
  const err = new Error('Generation failed after trying groq then bedrock');
  err.code = 'LLM_INVALID_JSON';
  throw err;
};

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
  fixtureServer = hardenedApp.listen(0, '127.0.0.1');
  await new Promise((r) => fixtureServer.once('listening', r));
  fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
  env.ALLOW_PRIVATE_TARGETS = true; // fixtures are on loopback
});

afterAll(async () => {
  env.ALLOW_PRIVATE_TARGETS = false;
  fixtureServer.close();
  await disconnectTestDb();
});

beforeEach(async () => {
  await User.deleteMany({});
  await TestRun.deleteMany({});
  grantStore.clear();
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Runner', email: 'runner@example.com',
    password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  token = res.body.data.token;
  user = await User.findOne({ email: 'runner@example.com' });
});

/** Approves the fixture host for this session. */
function grantHost(sessionId = 'default') {
  grantStore.grant({
    userId: user._id, sessionId,
    riskClass: RISK_CLASS.NETWORK_READ, host: new URL(fixtureUrl).host,
  });
}

// ── The state machine itself ─────────────────────────────────────────────────

describe('state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition(RUN_STATE.DRAFT, RUN_STATE.AWAITING_GRANT)).toBe(true);
    expect(canTransition(RUN_STATE.GENERATING, RUN_STATE.GEN_FAILED)).toBe(true);
    expect(canTransition(RUN_STATE.EXECUTING, RUN_STATE.EXEC_FAILED)).toBe(true);
    // Skipping generation is not a thing.
    expect(canTransition(RUN_STATE.DRAFT, RUN_STATE.COMPLETE)).toBe(false);
    // Terminal means terminal.
    for (const t of TERMINAL_STATES) {
      expect(canTransition(t, RUN_STATE.EXECUTING), t).toBe(false);
    }
  });

  it('refuses an illegal transition rather than corrupting the record', async () => {
    const run = await TestRun.create({
      userId: user._id, target: { url: 'https://x.test' }, state: RUN_STATE.DRAFT,
    });
    await expect(transition(run, RUN_STATE.COMPLETE))
      .rejects.toThrow(/Illegal run transition/);
  });
});

// ── Terminal states all persist ──────────────────────────────────────────────

describe('every terminal state persists a TestRun', () => {
  it('CANCELLED when the host was never approved, and no packet left', async () => {
    const run = await startRun({
      userId: user._id, sessionId: 'no-grant',
      target: { url: `${fixtureUrl}/users/1`, description: 'fixture' },
      llm: stubLlm(CASES),
    });

    expect(run.state).toBe(RUN_STATE.CANCELLED);
    expect(run.error.code).toBe('AWAITING_GRANT');
    expect(run.finishedAt).toBeTruthy();
    // It is IN THE DATABASE, not lost.
    expect(await TestRun.countDocuments({ userId: user._id })).toBe(1);
    // Generation never happened, so nothing was sent.
    expect(run.summary.totalTests).toBe(0);
  });

  it('GEN_FAILED is persisted and visible, never a fabricated pass', async () => {
    grantHost();
    const run = await startRun({
      userId: user._id,
      target: { url: `${fixtureUrl}/users/1`, description: 'fixture' },
      llm: failingLlm,
    });

    expect(run.state).toBe(RUN_STATE.GEN_FAILED);
    expect(run.error.message).toMatch(/Generation failed/);
    expect(run.functional).toHaveLength(0);
    // A hardcoded fallback would have produced fake passing cases here.
    expect(run.summary.passed).toBe(0);

    const stored = await TestRun.findById(run._id);
    expect(stored.state).toBe(RUN_STATE.GEN_FAILED);
  });

  it('COMPLETE records results, tokens and cost', async () => {
    grantHost();
    const run = await startRun({
      userId: user._id,
      target: { url: fixtureUrl, description: 'fixture', method: 'GET' },
      llm: stubLlm(CASES),
    });

    expect(run.state).toBe(RUN_STATE.COMPLETE);
    expect(run.summary.totalTests).toBe(2);
    expect(run.summary.passed).toBe(1);
    expect(run.summary.failed).toBe(1);
    expect(run.generation.inputTokens).toBe(50);
    expect(run.generation.costUsd).toBeCloseTo(0.00005);
    expect(run.finishedAt).toBeTruthy();
  });

  it('records the full state history as a trace', async () => {
    grantHost();
    const run = await startRun({
      userId: user._id, target: { url: fixtureUrl, description: 'fixture' },
      llm: stubLlm(CASES),
    });
    const states = run.stateHistory.map((h) => h.state);
    expect(states).toEqual([
      RUN_STATE.DRAFT, RUN_STATE.AWAITING_GRANT, RUN_STATE.GENERATING,
      RUN_STATE.EXECUTING, RUN_STATE.EXPLAINING, RUN_STATE.COMPLETE,
    ]);
  });

  it('skips EXPLAINING when everything passed', async () => {
    grantHost();
    const run = await startRun({
      userId: user._id, target: { url: fixtureUrl, description: 'fixture' },
      llm: stubLlm([CASES[0]]),
    });
    expect(run.stateHistory.map((h) => h.state)).not.toContain(RUN_STATE.EXPLAINING);
    expect(run.state).toBe(RUN_STATE.COMPLETE);
  });
});

// ── Explanation budget ───────────────────────────────────────────────────────

describe('the explanation budget is PER RUN, not per process', () => {
  it('a fresh budget is issued for every run', () => {
    const a = createExplainBudget({ max: 3 });
    a.used = 3;
    const b = createExplainBudget({ max: 3 });
    // A module-scoped flag would leave b already exhausted here.
    expect(b.used).toBe(0);
    expect(b.remaining()).toBe(3);
  });

  it('explains failures in run one AND run two, not just the first', async () => {
    let calls = 0;
    const llm = async () => {
      calls += 1;
      return { data: { explanation: `explanation ${calls}` } };
    };
    const target = { url: 'https://api.test', method: 'GET' };

    const runOne = [{ status: 'fail', name: 'a', assertions: [{ kind: 'status', expected: '200', actual: '500', pass: false }] }];
    const runTwo = [{ status: 'fail', name: 'b', assertions: [{ kind: 'status', expected: '200', actual: '500', pass: false }] }];

    const p1 = await explainRunFailures({ results: runOne, target, budget: createExplainBudget(), llm });
    const p2 = await explainRunFailures({ results: runTwo, target, budget: createExplainBudget(), llm });

    expect(p1).toBe(1);
    expect(p2).toBe(1); // a module-scoped flag would produce 0 here, forever
    expect(runTwo[0].explanation).toBe('explanation 2');
  });

  it('caps explanations within a single run', async () => {
    const llm = async () => ({ data: { explanation: 'why' } });
    const results = Array.from({ length: 6 }, (_, i) => ({
      status: 'fail', name: `t${i}`, assertions: [{ kind: 'status', expected: '200', actual: '500', pass: false }],
    }));
    const produced = await explainRunFailures({
      results, target: { url: 'https://x.test', method: 'GET' },
      budget: createExplainBudget({ max: 2 }), llm,
    });
    expect(produced).toBe(2);
    expect(results.filter((r) => r.explanation)).toHaveLength(2);
  });

  it('a slow explainer NEVER blocks the run', async () => {
    const hang = () => new Promise(() => {}); // resolves never
    const results = [{ status: 'fail', name: 't', assertions: [] }];
    const started = Date.now();
    const produced = await explainRunFailures({
      results, target: { url: 'https://x.test', method: 'GET' },
      budget: createExplainBudget(), llm: hang, timeoutMs: 150,
    });
    expect(produced).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results[0].explanation).toBeUndefined();
  });

  it('an explainer that throws does not fail the run', async () => {
    const boom = async () => { throw new Error('provider down'); };
    const results = [{ status: 'fail', name: 't', assertions: [] }];
    await expect(explainRunFailures({
      results, target: { url: 'https://x.test', method: 'GET' },
      budget: createExplainBudget(), llm: boom,
    })).resolves.toBe(0);
  });
});

// ── HTTP surface ─────────────────────────────────────────────────────────────

describe('POST /api/runs', () => {
  it('requires authentication', async () => {
    expect((await request(app).post('/api/runs').send({ url: 'https://x.test', description: 'd' })).status).toBe(401);
  });

  it('validates the body with field-level detail', async () => {
    const res = await request(app).post('/api/runs')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'not-a-url', description: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'url')).toBe(true);
  });

  it('returns 202 with a CANCELLED run when the host is not yet approved', async () => {
    const res = await request(app).post('/api/runs')
      .set('Authorization', `Bearer ${token}`)
      .set('x-session-id', 'sheet')
      .send({ url: `${fixtureUrl}/users/1`, description: 'fixture user API' });
    expect(res.status).toBe(202);
    expect(res.body.data.run.state).toBe(RUN_STATE.CANCELLED);
    expect(res.body.data.run.error.code).toBe('AWAITING_GRANT');
  });
});

describe('GET /api/runs', () => {
  it('lists only this user runs', async () => {
    grantHost();
    await startRun({
      userId: user._id, target: { url: fixtureUrl, description: 'mine' }, llm: stubLlm([CASES[0]]),
    });
    // Someone else's run.
    const other = await User.create({
      email: 'other@example.com', displayName: 'Other',
      authProviders: [{ provider: 'local', providerId: 'other@example.com', email: 'other@example.com' }],
    });
    await TestRun.create({ userId: other._id, target: { url: 'https://theirs.test' } });

    const res = await request(app).get('/api/runs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.runs[0].target.description).toBe('mine');
  });
});

describe('GET /api/runs/:id is scoped to its owner (no IDOR)', () => {
  it('returns 404 for another user run, never their data', async () => {
    // Looking a run up by id alone would let any authenticated user read any
    // run by guessing its id.
    const other = await User.create({
      email: 'victim@example.com', displayName: 'Victim',
      authProviders: [{ provider: 'local', providerId: 'victim@example.com', email: 'victim@example.com' }],
    });
    const theirs = await TestRun.create({
      userId: other._id, target: { url: 'https://secret.test', description: 'private' },
    });

    const res = await request(app).get(`/api/runs/${theirs._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('secret.test');
  });

  it('returns the owner own run', async () => {
    grantHost();
    const run = await startRun({
      userId: user._id, target: { url: fixtureUrl, description: 'fixture' }, llm: stubLlm([CASES[0]]),
    });
    const res = await request(app).get(`/api/runs/${run._id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.run.state).toBe(RUN_STATE.COMPLETE);
  });

  it('rejects a malformed id without touching the database', async () => {
    const res = await request(app).get('/api/runs/not-an-id').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe('service-level scoping', () => {
  it('getRun is scoped by userId', async () => {
    const other = await User.create({
      email: 'x@example.com', displayName: 'X',
      authProviders: [{ provider: 'local', providerId: 'x@example.com', email: 'x@example.com' }],
    });
    const theirs = await TestRun.create({ userId: other._id, target: { url: 'https://x.test' } });
    expect(await getRun({ userId: user._id, runId: theirs._id })).toBeNull();
    expect(await getRun({ userId: other._id, runId: theirs._id })).toBeTruthy();
  });

  it('listRuns is scoped by userId', async () => {
    const other = await User.create({
      email: 'y@example.com', displayName: 'Y',
      authProviders: [{ provider: 'local', providerId: 'y@example.com', email: 'y@example.com' }],
    });
    await TestRun.create({ userId: other._id, target: { url: 'https://y.test' } });
    expect((await listRuns({ userId: user._id })).total).toBe(0);
  });
});
