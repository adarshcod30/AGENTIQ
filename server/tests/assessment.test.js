/**
 * The assessment orchestrator: the phase pipeline, readiness, report, and a
 * real end-to-end run over HTTP.
 *
 * The pipeline test stubs the agent-level deps, so it drives the whole state
 * machine with no app, network or LLM. The HTTP test runs the REAL tools against
 * an empty workspace, which needs no LLM (no endpoints to interpret) and proves
 * the enqueue-and-poll flow reaches COMPLETE.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { Assessment, ASSESS_STATE } from '../src/models/Assessment.js';
import { Discovery } from '../src/models/Discovery.js';
import { runAssessment, createAssessment } from '../src/services/assessment.service.js';
import { computeReadiness, buildReport, renderReportMarkdown } from '../src/services/report.service.js';

const app = createApp({ logging: false });
const VULN = path.resolve(import.meta.dirname, '../../fixtures/vulnerable-api');
let token;
let userId;
let emptyDir;

async function auth(email) {
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Dev', email, password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  return res.body.data.token;
}

/** Stubbed agent-level deps: two endpoints, one with a failing test, one high finding. */
function stubDeps() {
  return {
    discover: async () => ({
      framework: 'express', endpointCount: 2,
      endpoints: [
        { method: 'GET', path: '/users/:id', params: ['id'], file: 'server.js', line: 1, composed: false },
        { method: 'POST', path: '/login', params: [], file: 'server.js', line: 2, composed: false },
      ],
      dependencies: [{ name: 'express', version: '5', dev: false }],
      scripts: { start: 'node server.js' }, config: {}, stats: {},
    }),
    inferIntent: async ({ endpoint }) => ({ intent: `handles ${endpoint.path}`, confidence: 'high', clarification: null }),
    testEndpoint: async ({ endpoint }) => ({
      summary: { passed: 3, failed: endpoint.path === '/login' ? 1 : 0, errored: 0 },
      functional: [], generation: {},
    }),
    securityAssess: async () => ({
      findings: [{
        lane: 'sast', category: 'code-eval', severity: 'high', confidence: 'potential',
        title: 'eval used', description: '', evidence: 'eval(x)', remediation: 'remove eval',
        owasp: 'API8:2023', location: { file: 'server.js', line: 3, endpoint: null },
      }],
      summary: { total: 1, bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 } },
      notes: [],
    }),
    ensureApp: async () => ({ baseUrl: 'http://127.0.0.1:4001', note: null }),
    stopApp: async () => {},
  };
}

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
  emptyDir = mkdtempSync(path.join(tmpdir(), 'empty-proj-'));
});

afterAll(async () => {
  rmSync(emptyDir, { recursive: true, force: true });
  await disconnectTestDb();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Project.deleteMany({}), Assessment.deleteMany({}), Discovery.deleteMany({}),
  ]);
  token = await auth('assess@example.com');
  userId = (await User.findOne({ email: 'assess@example.com' }))._id;
});

describe('runAssessment (stubbed pipeline)', () => {
  it('drives discover -> test -> scan -> analyze -> report -> complete', async () => {
    const project = await Project.create({ userId, name: 'Vuln', workspaceRoot: VULN });
    const created = await createAssessment({ userId, projectId: project._id, schedule: false });

    const done = await runAssessment({ assessmentId: created._id, deps: stubDeps() });

    expect(done.state).toBe(ASSESS_STATE.COMPLETE);
    expect(done.endpoints).toHaveLength(2);
    expect(done.endpoints.find((e) => e.path === '/login').failed).toBe(1);
    expect(done.security.findings).toHaveLength(1);

    // A high finding AND a failing endpoint are both deployment blockers.
    expect(done.readiness.ready).toBe(false);
    expect(done.readiness.blockers.some((b) => b.includes('code-eval'))).toBe(true);
    expect(done.readiness.blockers.some((b) => b.includes('/login'))).toBe(true);

    // The report is assembled and reflects the run.
    expect(done.report.project.framework).toBe('express');
    expect(done.report.discoveredApis).toHaveLength(2);
    expect(done.report.security.total).toBe(1);

    // Every phase is in the history, in order.
    const states = done.stateHistory.map((h) => h.state);
    expect(states).toEqual([
      'PENDING', 'DISCOVERING', 'TESTING', 'SCANNING', 'ANALYZING', 'REPORTING', 'COMPLETE',
    ]);
  });

  it('marks endpoints skipped when no app could be started', async () => {
    const project = await Project.create({ userId, name: 'Vuln', workspaceRoot: VULN });
    const created = await createAssessment({ userId, projectId: project._id, schedule: false });
    const deps = { ...stubDeps(), ensureApp: async () => ({ baseUrl: null, note: 'no start script' }) };
    const done = await runAssessment({ assessmentId: created._id, deps });
    expect(done.endpoints.every((e) => e.status === 'skipped')).toBe(true);
    expect(done.state).toBe(ASSESS_STATE.COMPLETE);
  });

  it('degrades to static-only when the app start times out, still reaching COMPLETE', async () => {
    const project = await Project.create({ userId, name: 'Mono', workspaceRoot: VULN });
    const created = await createAssessment({ userId, projectId: project._id, schedule: false });
    const deps = { ...stubDeps(), ensureApp: async () => { throw new Error('Timed out waiting for the app on port 58420'); } };
    const done = await runAssessment({ assessmentId: created._id, deps });
    // The whole run does NOT fail: the static scan and report still run.
    expect(done.state).toBe(ASSESS_STATE.COMPLETE);
    expect(done.baseUrl).toBeNull();
    expect(done.endpoints.every((e) => e.status === 'skipped')).toBe(true);
    expect(done.security.notes.some((n) => /could not be started/i.test(n))).toBe(true);
    // The report explains why the app did not start, as a recommendation.
    expect(done.report.recommendations.some((r) => /could not be started/i.test(r.title))).toBe(true);
  });

  it('records a failure with the phase, keeping partial state', async () => {
    const project = await Project.create({ userId, name: 'Vuln', workspaceRoot: VULN });
    const created = await createAssessment({ userId, projectId: project._id, schedule: false });
    const deps = { ...stubDeps(), securityAssess: async () => { throw new Error('scanner blew up'); } };
    const done = await runAssessment({ assessmentId: created._id, deps });
    expect(done.state).toBe(ASSESS_STATE.FAILED);
    expect(done.error.message).toContain('scanner blew up');
    expect(done.endpoints).toHaveLength(2); // testing results are kept
  });

  it('assesses a deployed URL: no local start, security points at the live URL, static skipped', async () => {
    const targetUrl = 'https://demo-app.example.com/';
    const project = await Project.create({ userId, name: 'Deployed', targetUrl });
    const created = await createAssessment({ userId, projectId: project._id, schedule: false });

    let scanArgs = null;
    const deps = {
      ...stubDeps(),
      securityAssess: async (args) => { scanArgs = args; return { findings: [], summary: { total: 0, bySeverity: {} }, notes: [] }; },
    };
    const done = await runAssessment({ assessmentId: created._id, deps });

    expect(done.state).toBe(ASSESS_STATE.COMPLETE);
    expect(done.baseUrl).toBe(targetUrl);
    // No source: the security scan pointed at the live URL and static scans were off.
    expect(scanArgs.url).toBe(targetUrl);
    expect(scanArgs.runStatic).toBe(false);
    expect(done.security.notes.some((n) => /deployed URL/i.test(n))).toBe(true);
  });

  it('with a folder AND a URL, never runs functional tests on the live app but still scans the source', async () => {
    const targetUrl = 'https://demo-app.example.com/';
    const project = await Project.create({ userId, name: 'Both', workspaceRoot: VULN, targetUrl });
    const created = await createAssessment({ userId, projectId: project._id, schedule: false });

    let scanArgs = null;
    let functionalCalls = 0;
    const deps = {
      ...stubDeps(),
      testEndpoint: async () => { functionalCalls += 1; return { summary: { passed: 1, failed: 0, errored: 0 }, functional: [], generation: {} }; },
      securityAssess: async (args) => { scanArgs = args; return { findings: [], summary: { total: 0, bySeverity: {} }, notes: [] }; },
    };
    const done = await runAssessment({ assessmentId: created._id, deps });

    expect(done.state).toBe(ASSESS_STATE.COMPLETE);
    expect(done.baseUrl).toBe(targetUrl);
    expect(functionalCalls).toBe(0); // the live app is never sent test writes
    expect(done.endpoints).toHaveLength(2);
    expect(done.endpoints.every((e) => e.status === 'skipped')).toBe(true);
    expect(scanArgs.runStatic).toBe(true); // source present, static scans ran
  });
});

describe('report service', () => {
  it('computeReadiness blocks on a high finding and a failing endpoint', () => {
    const readiness = computeReadiness({
      security: { findings: [{ severity: 'high', category: 'x', title: 't' }] },
      endpoints: [{ status: 'complete', failed: 2, method: 'GET', path: '/a' }],
      clarifications: [],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toHaveLength(2);
  });

  it('renders a report to Markdown with the verdict', () => {
    const report = buildReport({
      endpoints: [{ method: 'GET', path: '/a', intent: 'gets a', status: 'complete', passed: 1, failed: 0 }],
      security: { findings: [], summary: { bySeverity: {} }, notes: [] },
      readiness: { ready: true, blockers: [], warnings: [] },
      clarifications: [],
    }, { framework: 'express', endpointCount: 1, dependencies: [] });
    const md = renderReportMarkdown(report);
    expect(md).toContain('# Assessment report');
    expect(md).toContain('Readiness: READY');
    expect(md).toContain('not a guarantee of security');
  });
});

describe('assessment HTTP flow (real tools, empty workspace)', () => {
  it('enqueues an assessment and reaches a terminal state', async () => {
    const project = await Project.create({ userId, name: 'Empty', workspaceRoot: emptyDir });
    const res = await request(app).post('/api/assessments')
      .set('Authorization', `Bearer ${token}`).send({ projectId: String(project._id) });
    expect(res.status).toBe(201);
    const id = res.body.data.assessment.id ?? res.body.data.assessment._id;

    // Poll until the background job finishes (empty workspace, no LLM, fast).
    let state = 'PENDING';
    for (let i = 0; i < 40 && !['COMPLETE', 'FAILED'].includes(state); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const poll = await request(app).get(`/api/assessments/${id}`).set('Authorization', `Bearer ${token}`);
      state = poll.body.data.assessment.state;
    }
    expect(state).toBe('COMPLETE');
  }, 15000);

  it('will not read another user assessment (no IDOR)', async () => {
    const project = await Project.create({ userId, name: 'Empty', workspaceRoot: emptyDir });
    const mine = await createAssessment({ userId, projectId: project._id, schedule: false });
    const otherToken = await auth('intruder@example.com');
    const res = await request(app).get(`/api/assessments/${mine._id}`).set('Authorization', `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });
});
