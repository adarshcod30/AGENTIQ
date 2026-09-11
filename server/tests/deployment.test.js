/**
 * The Deployment Agent (docs/01_PRD.md F5).
 *
 * F5's acceptance criterion is not "a deployment happened". It is:
 *
 *   - preflight refuses to deploy something that cannot work, BEFORE any
 *     deploy.write action is attempted;
 *   - the credential never appears in an error, a log or an audit row;
 *   - a failed deployment is persisted, not swallowed;
 *   - and a successful one is VERIFIED against the URL that went live.
 *
 * Both external control planes are faked (tests/helpers/fakeProviders.js), so
 * this suite needs no Render credential, creates no real infrastructure, and
 * makes no outbound request. What is real: the agent, the tool, the permission
 * gate, the egress guard, the audit writer and the database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { fakeRender, fakeGitHub, listen } from './helpers/fakeProviders.js';
import { parseGitHubRepo, runPreflight, CHECK } from '../src/agents/deployment.agent.js';
import { redact } from '../src/mcp/tools/deploy_service.js';
import {
  startDeployment, missingGrants, AUTO_VERIFY_FAMILIES, REQUIRES_APPROVAL_FAMILIES,
} from '../src/services/deployment.service.js';
import { Deployment, DEPLOY_STATE } from '../src/models/Deployment.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { getTool } from '../src/mcp/registry.js';
import { grantStore, RISK_CLASS } from '../src/mcp/permissions.js';
import { AuditEvent } from '../src/models/AuditEvent.js';
import { TestRun } from '../src/models/TestRun.js';
import { User } from '../src/models/User.js';
import { env } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { app as hardenedApp } from '../../fixtures/hardened-api/server.js';

const API_KEY = 'rnd_test_key_abcdef123456';
const REPO = 'https://github.com/acme/demo-api';
const SESSION = 'deploy-test';

const app = createApp({ logging: false });
const servers = [];
let githubUrl;
let fixtureUrl;
let user;
let token;

const stubLlm = (cases) => async ({ schema }) => ({
  data: schema.parse({ cases }),
  provider: 'stub', model: 'stub-1',
  inputTokens: 10, outputTokens: 20, costUsd: 0.00001,
  attempts: 1, repairStage: 'direct', durationMs: 1,
});

const OK_CASE = [{
  name: 'Root responds', intent: 'the deployed service answers', method: 'GET',
  path: 'users/1', headers: {}, category: 'positive',
  assertions: [{ kind: 'status', expected: 200 }],
}];

/** Starts a fake Render, points the tool at it, returns its recorded state. */
async function withRender(opts = {}) {
  const { app: rApp, state } = fakeRender({ apiKey: API_KEY, ...opts });
  const { server, url } = await listen(rApp);
  servers.push(server);
  env.RENDER_API_BASE = url;
  return state;
}

async function withGitHub(opts = {}) {
  const { app: gApp } = fakeGitHub(opts);
  const { server, url } = await listen(gApp);
  servers.push(server);
  return url;
}

/** Grants everything the happy path needs, as the user would via the sheet. */
function grantAll(host) {
  grantStore.grant({ userId: user._id, sessionId: SESSION, riskClass: RISK_CLASS.NETWORK_READ, host });
  grantStore.grant({
    userId: user._id, sessionId: SESSION, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: true,
  });
}

const deployInput = (over = {}) => ({
  repo: REPO, branch: 'main', serviceName: 'demo-api', runtime: 'node',
  plan: 'free', region: 'oregon', buildCommand: 'npm install', startCommand: 'npm start',
  envVars: {}, dryRun: false, ...over,
});

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
  const fixture = await listen(hardenedApp);
  servers.push(fixture.server);
  fixtureUrl = fixture.url;
  // Everything is on loopback; this is precisely what the flag exists for, and
  // the env schema refuses it when NODE_ENV=production.
  env.ALLOW_PRIVATE_TARGETS = true;
});

afterAll(async () => {
  env.ALLOW_PRIVATE_TARGETS = false;
  delete env.RENDER_API_KEY;
  delete env.RENDER_API_BASE;
  for (const s of servers) s.close();
  await disconnectTestDb();
});

beforeEach(async () => {
  await Promise.all([
    User.deleteMany({}), Deployment.deleteMany({}), TestRun.deleteMany({}),
  ]);
  await AuditEvent.collection.deleteMany({});
  grantStore.clear();
  env.RENDER_API_KEY = API_KEY;

  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Deployer', email: 'deploy@example.com',
    password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  token = res.body.data.token;
  user = await User.findOne({ email: 'deploy@example.com' });

  githubUrl = await withGitHub();
});

/* ══ the credential ═══════════════════════════════════════════════════════ */

describe('the API key never escapes', () => {
  it('redact() removes the configured key from any string', () => {
    expect(redact(`bearer ${API_KEY} failed`)).not.toContain(API_KEY);
    expect(redact(`bearer ${API_KEY} failed`)).toContain('«redacted»');
  });

  it('redact() also removes anything merely SHAPED like a Render key', () => {
    // Provider error bodies sometimes echo a different key than ours.
    expect(redact('token rnd_someOtherKey123456 rejected')).toBe('token rnd_«redacted» rejected');
  });

  it('a rejected credential produces an error containing no key material', async () => {
    await withRender({ apiKey: 'rnd_a_completely_different_key' });
    grantAll(new URL(githubUrl).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, verify: false,
    });

    expect(dep.state).toBe(DEPLOY_STATE.DEPLOY_FAILED);
    expect(dep.error.message).not.toContain(API_KEY);
    expect(dep.error.message).toMatch(/rejected the credential/i);
  });

  it('no audit row anywhere contains the key', async () => {
    await withRender();
    grantAll(new URL(githubUrl).host);
    await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, verify: false,
    });

    const rows = await AuditEvent.find({}).lean();
    expect(rows.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(API_KEY);
    expect(serialised).not.toContain('rnd_');
  });

  it('the key is not part of the tool input schema, so it cannot be passed in', () => {
    const { inputSchema } = getTool('deploy_service');
    expect(Object.keys(inputSchema.shape)).not.toContain('apiKey');
    expect(Object.keys(inputSchema.shape)).not.toContain('RENDER_API_KEY');
  });
});

/* ══ preflight ════════════════════════════════════════════════════════════ */

describe('parseGitHubRepo', () => {
  it('accepts an https GitHub URL and strips .git', () => {
    expect(parseGitHubRepo('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('refuses anything that is not an https github.com repo URL', () => {
    for (const bad of ['http://github.com/o/r', 'https://gitlab.com/o/r', 'https://github.com/o', 'nonsense']) {
      expect(parseGitHubRepo(bad)).toBeNull();
    }
  });
});

describe('preflight: read-only, and it stops a doomed deploy before it starts', () => {
  const run = async (opts = {}, input = {}) => {
    const gh = await withGitHub(opts);
    grantStore.grant({
      userId: user._id, sessionId: SESSION, riskClass: RISK_CLASS.NETWORK_READ, host: new URL(gh).host,
    });
    return runPreflight({
      ...deployInput(input), githubApi: gh,
      runTool: (n, i, c) => getTool(n).handler(i, { userId: user._id, sessionId: SESSION, ...c }),
      context: { userId: user._id, sessionId: SESSION },
    });
  };

  it('passes every check on a healthy repository', async () => {
    const { checks, ok } = await run();
    expect(ok).toBe(true);
    expect(checks.every((c) => c.status !== CHECK.FAIL)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['repo-format', 'service-name', 'repo-reachable', 'branch-exists', 'start-command', 'env-vars']),
    );
  });

  it('FAILS when the repository does not exist', async () => {
    const { checks, ok } = await run({ repoExists: false });
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'repo-reachable').status).toBe(CHECK.FAIL);
  });

  it('FAILS when the branch does not exist', async () => {
    const { checks, ok } = await run({ branches: ['develop'] });
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'branch-exists').detail).toMatch(/does not exist/);
  });

  it('FAILS when package.json has no start script: the commonest Render failure', async () => {
    // A build that succeeds and a service that never binds a port. Catching it
    // here costs one request; catching it on Render costs a whole build.
    const { checks, ok } = await run({ packageJson: { name: 'x', scripts: { test: 'vitest' } } });
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'start-command').detail).toMatch(/no "start" script/);
  });

  it('FAILS when there is no package.json at all for a node runtime', async () => {
    const { ok, checks } = await run({ packageJson: null });
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'start-command').status).toBe(CHECK.FAIL);
  });

  it('FAILS on a service name Render would reject', async () => {
    const { ok, checks } = await run({}, { serviceName: 'Not Valid!' });
    expect(ok).toBe(false);
    expect(checks.find((c) => c.name === 'service-name').status).toBe(CHECK.FAIL);
  });

  it('WARNS about a hardcoded PORT without failing the deployment', async () => {
    const { ok, checks } = await run({}, { envVars: { PORT: '3000' } });
    expect(ok).toBe(true);
    const c = checks.find((x) => x.name === 'env-vars');
    expect(c.status).toBe(CHECK.WARN);
    expect(c.detail).toMatch(/Render assigns the port/);
  });

  it('WARNS about values shaped like live credentials, naming the KEY not the value', async () => {
    const secret = 'gsk_abcdefghijklmnopqrstuvwxyz01';
    const { checks } = await run({}, { envVars: { GROQ_API_KEY: secret } });
    const c = checks.find((x) => x.name === 'env-vars');
    expect(c.status).toBe(CHECK.WARN);
    expect(c.detail).toContain('GROQ_API_KEY');
    expect(c.detail).not.toContain(secret);
  });

  it('reports a private repo as reachable but flags the clone authorisation', async () => {
    const { ok, checks } = await run({ priv: true });
    expect(ok).toBe(true);
    expect(checks.find((c) => c.name === 'repo-reachable').detail).toMatch(/private/);
  });

  it('a permission refusal FAILS the check: it never degrades to a warn', async () => {
    // Reporting "could not reach GitHub" as a warn while returning ok:true would
    // let preflight bless a repository it never actually read. "We were not
    // allowed to look" and "we looked and it is fine" must not produce the same
    // verdict.
    const gh = await withGitHub();
    grantStore.clear(); // no network.read grant for the GitHub host

    const result = await runPreflight({
      ...deployInput(), githubApi: gh,
      runTool: (n, i, c) => getTool(n).handler(i, { userId: user._id, sessionId: SESSION, ...c }),
      context: { userId: user._id, sessionId: SESSION },
    });

    expect(result.ok).toBe(false);
    expect(result.needsGrant).toBe(true);
    for (const name of ['repo-reachable', 'branch-exists', 'start-command']) {
      expect(result.checks.find((c) => c.name === name).status).toBe(CHECK.FAIL);
    }
    // The purely local checks still report, so the user sees partial results.
    expect(result.checks.find((c) => c.name === 'repo-format').status).toBe(CHECK.PASS);
  });

  it('refuses to deploy when preflight was never allowed to run', async () => {
    const render = await withRender();
    const gh = await withGitHub();
    grantStore.grant({
      userId: user._id, sessionId: SESSION, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: true,
    });
    // deploy.write granted, but NOT network.read for GitHub.

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: gh, sleep: async () => {}, verify: false,
    });

    expect(dep.state).toBe(DEPLOY_STATE.PREFLIGHT_FAILED);
    expect(dep.error.code).toBe('PERMISSION_DENIED');
    expect(render.requests).toHaveLength(0);
  });
});

/* ══ the deploy phase ═════════════════════════════════════════════════════ */

describe('deploying', () => {
  it('creates a service, polls to live, and records what happened', async () => {
    const render = await withRender({ statuses: ['build_in_progress', 'build_in_progress', 'live'] });
    grantAll(new URL(githubUrl).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, verify: false,
    });

    expect(dep.state).toBe(DEPLOY_STATE.COMPLETE);
    expect(dep.serviceId).toBe('srv-1');
    expect(dep.deployId).toBe('dep-1');
    expect(render.requests.some((r) => r.method === 'POST' && r.path === '/services')).toBe(true);
    // It polled until terminal rather than assuming the first answer.
    expect(render.requests.filter((r) => /\/deploys\/dep-1$/.test(r.path)).length).toBe(3);
  });

  it('reuses an existing service instead of creating a duplicate', async () => {
    const render = await withRender({
      services: [{ id: 'srv-existing', name: 'demo-api', serviceDetails: { url: null } }],
    });
    grantAll(new URL(githubUrl).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, verify: false,
    });

    expect(dep.serviceId).toBe('srv-existing');
    expect(render.requests.some((r) => r.method === 'POST' && r.path === '/services')).toBe(false);
    expect(render.requests.some((r) => r.path === '/services/srv-existing/deploys')).toBe(true);
  });

  it('matches the service name EXACTLY, not by prefix', async () => {
    // Render's name filter is a prefix match, so "demo-api" would also return
    // "demo-api-staging". Deploying into the wrong service would be severe.
    const render = await withRender({
      services: [{ id: 'srv-staging', name: 'demo-api-staging', serviceDetails: { url: null } }],
    });
    grantAll(new URL(githubUrl).host);

    await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, verify: false,
    });

    expect(render.requests.some((r) => r.method === 'POST' && r.path === '/services')).toBe(true);
    expect(render.requests.some((r) => r.path === '/services/srv-staging/deploys')).toBe(false);
  });

  it('persists a FAILED deployment rather than swallowing it', async () => {
    await withRender({ statuses: ['build_in_progress', 'build_failed'] });
    grantAll(new URL(githubUrl).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, verify: false,
    });

    expect(dep.state).toBe(DEPLOY_STATE.DEPLOY_FAILED);
    expect(dep.error.message).toMatch(/build_failed/);
    expect(await Deployment.countDocuments({})).toBe(1);
    expect(dep.finishedAt).toBeTruthy();
  });

  it('gives up rather than polling forever, and says so', async () => {
    await withRender({ statuses: ['build_in_progress'] });
    grantAll(new URL(githubUrl).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, maxPolls: 3, pollIntervalMs: 1, verify: false,
    });

    expect(dep.state).toBe(DEPLOY_STATE.DEPLOY_FAILED);
    expect(dep.error.message).toMatch(/did not finish/i);
    expect(dep.error.message).toMatch(/may still be building/);
  });

  it('a preflight failure means ZERO requests reach Render', async () => {
    const render = await withRender();
    const gh = await withGitHub({ repoExists: false });
    grantAll(new URL(gh).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: gh, sleep: async () => {}, verify: false,
    });

    expect(dep.state).toBe(DEPLOY_STATE.PREFLIGHT_FAILED);
    expect(render.requests).toHaveLength(0);
    expect(dep.preflight.some((c) => c.status === CHECK.FAIL)).toBe(true);
  });

  it('a dry run sends NO mutating request and cannot masquerade as a deployment', async () => {
    const render = await withRender();
    grantAll(new URL(githubUrl).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput({ dryRun: true }),
      githubApi: githubUrl, sleep: async () => {}, verify: false,
    });

    expect(render.requests.some((r) => r.method === 'POST')).toBe(false);
    expect(dep.state).not.toBe(DEPLOY_STATE.COMPLETE);
    expect(dep.error.code).toBe('DRY_RUN');
  });

  it('a dry run shows env var KEYS but never their values', async () => {
    await withRender();
    grantAll(new URL(githubUrl).host);
    const out = await getTool('deploy_service').handler({
      action: 'create_service', serviceName: 'demo-api', repo: REPO, ownerId: 'usr-1',
      envVars: { DATABASE_URL: 'postgres://user:hunter2@db/app' }, dryRun: true,
    }, { userId: user._id, sessionId: SESSION });

    const rendered = JSON.stringify(out.wouldSend);
    expect(rendered).toContain('DATABASE_URL');
    expect(rendered).not.toContain('hunter2');
    expect(out.dryRun).toBe(true);
  });
});

/* ══ permissions ══════════════════════════════════════════════════════════ */

describe('deploy.write is the strictest gate in the system', () => {
  const call = () => getTool('deploy_service').handler(
    { action: 'find_owner' }, { userId: user._id, sessionId: SESSION },
  );

  it('refuses with no grant at all', async () => {
    await expect(call()).rejects.toThrow(/no deploy.write grant/i);
  });

  it('refuses with a grant that was never CONFIRMED', async () => {
    // Approving "this app may deploy" is not approving a specific deployment.
    grantStore.grant({
      userId: user._id, sessionId: SESSION, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: false,
    });
    await expect(call()).rejects.toThrow(/requires explicit confirmation/i);
  });

  it('proceeds once the grant is confirmed', async () => {
    await withRender();
    grantStore.grant({
      userId: user._id, sessionId: SESSION, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: true,
    });
    await expect(call()).resolves.toMatchObject({ ownerId: 'usr-fake-001' });
  });

  it('missingGrants lists everything the flow needs, in one pass', () => {
    const missing = missingGrants({ userId: user._id, sessionId: SESSION });
    expect(missing.map((m) => m.riskClass)).toEqual(
      expect.arrayContaining(['network.read', 'deploy.write']),
    );
    expect(missing.find((m) => m.riskClass === 'network.read').host).toBe('api.github.com');
  });
});

/* ══ the point of F5: verification ════════════════════════════════════════ */

describe('a deployment verifies itself', () => {
  it('runs the testing agent against the LIVE url and attaches the result', async () => {
    await withRender({ liveUrl: fixtureUrl });
    grantAll(new URL(githubUrl).host);

    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, llm: stubLlm(OK_CASE),
    });

    expect(dep.state).toBe(DEPLOY_STATE.COMPLETE);
    expect(dep.liveUrl).toBe(fixtureUrl);
    expect(dep.postDeployRunId).toBeTruthy();

    const run = await TestRun.findById(dep.postDeployRunId).lean();
    expect(run.target.url).toBe(fixtureUrl);
    expect(dep.verification.testsTotal).toBeGreaterThan(0);
    expect(dep.verification.healthy).toBe(true);
  });

  it('auto-grants network.read for the deployed host ONLY, never network.probe', async () => {
    // The URL did not exist when the user answered the sheet, so a grant for it
    // could not have been given. Granting read for exactly that host is
    // defensible; granting permission to fire SQLi payloads is not.
    await withRender({ liveUrl: fixtureUrl });
    grantAll(new URL(githubUrl).host);

    await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, llm: stubLlm(OK_CASE),
    });

    const host = new URL(fixtureUrl).host;
    const grants = grantStore.list({ userId: user._id, sessionId: SESSION });
    expect(grants.some((g) => g.riskClass === 'network.read' && g.host === host)).toBe(true);
    expect(grants.some((g) => g.riskClass === 'network.probe')).toBe(false);
  });

  it('only the read-only security families run automatically', () => {
    expect(AUTO_VERIFY_FAMILIES).toEqual(['cors', 'headers']);
    expect(REQUIRES_APPROVAL_FAMILIES).toEqual(expect.arrayContaining(['sqli', 'xss', 'auth']));
  });

  it('a verification failure does not un-deploy a live service', async () => {
    // The service IS live. Recording the deployment as failed would be a lie.
    await withRender({ liveUrl: fixtureUrl });
    grantAll(new URL(githubUrl).host);

    const boom = async () => { throw Object.assign(new Error('provider down'), { code: 'LLM_INVALID_JSON' }); };
    const dep = await startDeployment({
      userId: user._id, sessionId: SESSION, input: deployInput(),
      githubApi: githubUrl, sleep: async () => {}, llm: boom,
    });

    expect(dep.state).toBe(DEPLOY_STATE.COMPLETE);
    expect(dep.liveUrl).toBe(fixtureUrl);
    expect(dep.verification.healthy).toBe(false);
  });
});

/* ══ routes ═══════════════════════════════════════════════════════════════ */

describe('/api/deployments', () => {
  const auth = (r) => r.set('Authorization', `Bearer ${token}`).set('x-session-id', SESSION);

  it('requires authentication', async () => {
    expect((await request(app).get('/api/deployments')).status).toBe(401);
  });

  it('GET /config reports what the agent can and cannot do', async () => {
    const res = await auth(request(app).get('/api/deployments/config'));
    expect(res.status).toBe(200);
    expect(res.body.data.configured).toBe(true);
    expect(res.body.data.provider).toBe('render');
    expect(res.body.data.requiresApprovalFamilies).toContain('sqli');
  });

  it('refuses honestly when RENDER_API_KEY is absent', async () => {
    delete env.RENDER_API_KEY;
    const res = await auth(request(app).post('/api/deployments')).send(deployInput());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DEPLOY_NOT_CONFIGURED');
  });

  it('returns every missing grant at once rather than failing three times', async () => {
    const res = await auth(request(app).post('/api/deployments')).send(deployInput());
    expect(res.status).toBe(403);
    expect(res.body.error.details.needsGrant.length).toBeGreaterThanOrEqual(2);
  });

  it('validates the repo URL', async () => {
    const res = await auth(request(app).post('/api/deployments')).send(deployInput({ repo: 'not-a-url' }));
    expect(res.status).toBe(400);
  });

  it('/config is not shadowed by /:id', async () => {
    // Express matches in order; with /:id first, "config" is read as an id.
    const res = await auth(request(app).get('/api/deployments/config'));
    expect(res.status).toBe(200);
  });

  it('never returns another user deployment (IDOR)', async () => {
    const other = await User.create({
      email: 'other@example.com', displayName: 'Other',
      authProviders: [{ provider: 'local', providerId: 'o', email: 'other@example.com' }],
    });
    const theirs = await Deployment.create({
      userId: other._id, repo: REPO, serviceName: 'theirs',
    });

    const res = await auth(request(app).get(`/api/deployments/${theirs._id}`));
    expect(res.status).toBe(404);
  });
});
