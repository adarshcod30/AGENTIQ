/**
 * Pluggable deployment (Phase 6): requirement detection, failure diagnosis, the
 * provider registry, and a real dispatch through the second provider to prove
 * the seam.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { detectRequirements } from '../src/deploy/requirements.js';
import { diagnoseFailure } from '../src/deploy/diagnose.js';
import { getProvider, listProviders, PROVIDER_NAMES } from '../src/deploy/index.js';
import { startDeployment } from '../src/services/deployment.service.js';
import { User } from '../src/models/User.js';
import { Deployment } from '../src/models/Deployment.js';

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
