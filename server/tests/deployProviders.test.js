/**
 * Pluggable deployment (Phase 6): requirement detection, failure diagnosis, the
 * provider registry, and a real dispatch through the second provider to prove
 * the seam.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { detectRequirements } from '../src/deploy/requirements.js';
import { diagnoseFailure } from '../src/deploy/diagnose.js';
import { proposeRetry } from '../src/deploy/retry.js';
import { getProvider, listProviders, PROVIDER_NAMES } from '../src/deploy/index.js';
import { startDeployment, retryDeployment } from '../src/services/deployment.service.js';
import { User } from '../src/models/User.js';
import { Deployment, DEPLOY_STATE } from '../src/models/Deployment.js';

describe('detectRequirements', () => {
  it('reads build and start commands from package.json', () => {
    const req = detectRequirements({ scripts: { build: 'tsc', start: 'node dist/x.js' }, dependencies: { express: '5' } });
    expect(req.runtime).toBe('node');
    expect(req.framework).toBe('express');
    expect(req.buildCommand).toBe('npm install && npm run build');
    expect(req.startCommand).toBe('npm start');
    expect(req.warnings).toEqual([]);
  });

  it('warns when there is no way to run the app', () => {
    const req = detectRequirements({ scripts: {}, dependencies: {} });
    expect(req.startCommand).toBeNull();
    expect(req.warnings[0]).toMatch(/no dockerfile/i);
  });

  it('reports docker runtime when a Dockerfile is present', () => {
    const req = detectRequirements({ scripts: {} }, { hasDockerfile: true });
    expect(req.runtime).toBe('docker');
    expect(req.warnings).toEqual([]);
  });
});

describe('diagnoseFailure', () => {
  it.each([
    ['process.env.API_KEY is undefined', 'missing-env-var'],
    ['npm ERR! missing script: start', 'missing-start-script'],
    ['Error: Cannot find module "left-pad"', 'missing-dependency'],
    ['Error: listen EADDRINUSE address already in use', 'port-binding'],
    ['error TS2304: cannot find name', 'build-error'],
    ['something totally unrecognised', 'unknown'],
  ])('classifies %s as %s', (log, classification) => {
    expect(diagnoseFailure(log).classification).toBe(classification);
  });

  it('marks a behaviour-changing fix so it can be gated on approval', () => {
    const d = diagnoseFailure('no open ports detected');
    expect(d.safeFix.behaviourChanging).toBe(true);
    expect(d.suggestion).toMatch(/process\.env\.PORT/);
  });
});

describe('proposeRetry', () => {
  it('offers a config-only retry for a missing environment variable', () => {
    const p = proposeRetry(diagnoseFailure('process.env.API_KEY is undefined'));
    expect(p.kind).toBe('set-env');
    expect(p.retryable).toBe(true);
    expect(p.requiredEnvVars).toContain('API_KEY');
    expect(p.requiresApproval).toBe(true);
  });

  it('falls back to the declared env keys when the logs name none', () => {
    const diag = { safeFix: { type: 'env-var', key: null }, suggestion: 'set it' };
    const p = proposeRetry(diag, { envVars: ['DATABASE_URL', 'SESSION_SECRET'] });
    expect(p.kind).toBe('set-env');
    expect(p.requiredEnvVars).toEqual(['DATABASE_URL', 'SESSION_SECRET']);
  });

  it('refuses to auto-apply a code change (a hardcoded port)', () => {
    const p = proposeRetry(diagnoseFailure('no open ports detected'));
    expect(p.kind).toBe('code-change');
    expect(p.retryable).toBe(false);
    expect(p.message).toMatch(/process\.env\.PORT/);
  });

  it('offers nothing to retry when there is no safe fix', () => {
    const p = proposeRetry(diagnoseFailure('something totally unrecognised'));
    expect(p.kind).toBe('none');
    expect(p.retryable).toBe(false);
  });
});

describe('provider registry', () => {
  it('lists render (available) and railway (stub) without leaking credentials', () => {
    const providers = listProviders();
    const byName = Object.fromEntries(providers.map((p) => [p.name, p]));
    expect(byName.render.status).toBe('available');
    expect(byName.railway.status).toBe('stub');
    for (const p of providers) expect(p).not.toHaveProperty('apiKey');
    expect(PROVIDER_NAMES).toContain('render');
    expect(PROVIDER_NAMES).toContain('railway');
  });

  it('returns null for an unknown provider', () => {
    expect(getProvider('heroku')).toBeNull();
  });

  it('every provider implements the interface', () => {
    for (const p of Object.values({ render: getProvider('render'), railway: getProvider('railway') })) {
      for (const method of ['isConfigured', 'detectRequirements', 'diagnoseFailure', 'preflight', 'deploy']) {
        expect(typeof p[method]).toBe('function');
      }
    }
  });
});

describe('dispatch through the second provider (the seam)', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });
  beforeEach(async () => { await Promise.all([User.deleteMany({}), Deployment.deleteMany({})]); });

  it('routes a railway deploy through the stub and records a clean failure', async () => {
    const user = await User.create({ email: 'd@example.com', displayName: 'D', authProviders: [{ provider: 'local', providerId: 'd@example.com', email: 'd@example.com' }] });
    const dep = await startDeployment({
      userId: user._id,
      input: { provider: 'railway', repo: 'https://github.com/acme/app', serviceName: 'app' },
      runTool: async () => ({}), // railway stub never calls a tool
    });
    expect(dep.provider).toBe('railway');
    expect(dep.state).toBe('DEPLOY_FAILED');
    expect(dep.error.code).toBe('PROVIDER_NOT_IMPLEMENTED');
  });

  it('rejects an unknown provider', async () => {
    const user = await User.create({ email: 'd2@example.com', displayName: 'D', authProviders: [{ provider: 'local', providerId: 'd2@example.com', email: 'd2@example.com' }] });
    await expect(startDeployment({
      userId: user._id,
      input: { provider: 'nope', repo: 'https://github.com/acme/app', serviceName: 'app' },
      runTool: async () => ({}),
    })).rejects.toThrow(/Unknown deployment provider/);
  });
});

describe('approval-gated retry', () => {
  beforeAll(async () => { await connectTestDb(); });
  afterAll(async () => { await disconnectTestDb(); });
  beforeEach(async () => { await Promise.all([User.deleteMany({}), Deployment.deleteMany({})]); });

  async function user(email = 'r@example.com') {
    return User.create({ email, displayName: 'R', authProviders: [{ provider: 'local', providerId: email, email }] });
  }

  /** A failed deployment carrying the given retry proposal. */
  async function failedWith(userId, proposal) {
    return Deployment.create({
      userId, provider: 'railway', repo: 'https://github.com/acme/app', branch: 'main',
      serviceName: 'app', state: DEPLOY_STATE.DEPLOY_FAILED,
      diagnosis: { classification: 'x', explanation: '', suggestion: 's', safeFix: null, proposal },
    });
  }

  it('refuses a retry that was not approved', async () => {
    const u = await user();
    const dep = await failedWith(u._id, { kind: 'set-env', retryable: true, requiredEnvVars: ['API_KEY'] });
    await expect(retryDeployment({ userId: u._id, deploymentId: dep._id, approved: false }))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('refuses to retry a deployment that did not fail', async () => {
    const u = await user();
    const dep = await Deployment.create({
      userId: u._id, provider: 'railway', repo: 'https://github.com/acme/app', serviceName: 'app',
      state: DEPLOY_STATE.COMPLETE,
    });
    await expect(retryDeployment({ userId: u._id, deploymentId: dep._id, approved: true }))
      .rejects.toMatchObject({ code: 'NOT_RETRYABLE' });
  });

  it('refuses to auto-apply a code-change fix, even when approved', async () => {
    const u = await user();
    const dep = await failedWith(u._id, { kind: 'code-change', retryable: false, message: 'Bind to process.env.PORT.' });
    await expect(retryDeployment({ userId: u._id, deploymentId: dep._id, approved: true }))
      .rejects.toMatchObject({ code: 'CODE_CHANGE_REQUIRED' });
  });

  it('retries a config fix: a new deployment linked to the original', async () => {
    const u = await user();
    const prev = await failedWith(u._id, { kind: 'set-env', retryable: true, requiredEnvVars: ['API_KEY'] });
    const next = await retryDeployment({
      userId: u._id, deploymentId: prev._id, approved: true,
      envVars: { API_KEY: 'supplied-by-the-user' }, runTool: async () => ({}),
    });
    expect(String(next.retryOf)).toBe(String(prev._id));
    expect(next.provider).toBe('railway');
    expect(String(next._id)).not.toBe(String(prev._id));
  });

  it('is scoped to the owner: another user cannot retry it', async () => {
    const owner = await user('owner@example.com');
    const other = await user('other@example.com');
    const dep = await failedWith(owner._id, { kind: 'set-env', retryable: true, requiredEnvVars: [] });
    await expect(retryDeployment({ userId: other._id, deploymentId: dep._id, approved: true }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
