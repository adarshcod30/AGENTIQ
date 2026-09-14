/**
 * The Vercel provider deploy, end to end against a fake Vercel control plane.
 *
 * Proves the provider's logic: it uses the CURRENT user's connected token, sends
 * the right git deployment request, polls readyState to a terminal state, and
 * maps the result. It creates no real Vercel infrastructure and makes no real
 * outbound request; a live Vercel account is only needed to confirm Vercel
 * accepts the exact request shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { fakeVercel, listen } from './helpers/fakeProviders.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Connection } from '../src/models/Connection.js';
import { setConnection } from '../src/services/connections.service.js';
import { vercelProvider } from '../src/deploy/vercel.provider.js';
import { env } from '../src/config/env.js';

const app = createApp({ logging: false });
const VTOKEN = 'vercel_test_token_abc123';
const servers = [];
const noSleep = () => Promise.resolve();
const input = { repo: 'https://github.com/acme/demo-api', branch: 'main', serviceName: 'demo-api' };
let userId;

async function withVercel(opts = {}) {
  const { app: vApp, state } = fakeVercel({ token: VTOKEN, ...opts });
  const { server, url } = await listen(vApp);
  servers.push(server);
  env.VERCEL_API_BASE = url;
  return state;
}

beforeAll(async () => {
  await connectTestDb();
  // The fake Vercel is on loopback; this flag is exactly what permits that, and
  // the env schema refuses it when NODE_ENV=production.
  env.ALLOW_PRIVATE_TARGETS = true;
});
afterAll(async () => {
  env.ALLOW_PRIVATE_TARGETS = false;
  for (const s of servers) s.close();
  delete env.VERCEL_API_BASE;
  await disconnectTestDb();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Connection.deleteMany({})]);
  await request(app).post('/api/auth/register').send({
    displayName: 'Dev', email: 'v@example.com', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  userId = (await User.findOne({ email: 'v@example.com' }))._id;
});

describe('Vercel provider deploy', () => {
  it("deploys the repo with the user's connected token and returns the live URL", async () => {
    await setConnection({ userId, provider: 'vercel', token: VTOKEN });
    const state = await withVercel({ statuses: ['BUILDING', 'READY'], url: 'demo-api-abc.vercel.app' });

    const result = await vercelProvider.deploy(input, {
      context: { userId }, sleep: noSleep, pollIntervalMs: 0, maxPolls: 5,
      resolveRepoId: async () => 987654,
    });

    expect(result.ok).toBe(true);
    expect(result.deployStatus).toBe('READY');
    expect(result.liveUrl).toBe('https://demo-api-abc.vercel.app');
    expect(result.deployId).toBeTruthy();

    // The deploy call carried the user's token and the right git source. Vercel
    // identifies the repo by its numeric id, not owner/name.
    const post = state.requests.find((r) => r.method === 'POST');
    expect(post.auth).toBe(`Bearer ${VTOKEN}`);
    expect(post.body.gitSource).toMatchObject({ type: 'github', repoId: 987654, ref: 'main' });
  });

  it('reports a failed deployment without throwing', async () => {
    await setConnection({ userId, provider: 'vercel', token: VTOKEN });
    await withVercel({ statuses: ['ERROR'] });
    const result = await vercelProvider.deploy(input, {
      context: { userId }, sleep: noSleep, pollIntervalMs: 0, maxPolls: 5, resolveRepoId: async () => 987654,
    });
    expect(result.ok).toBe(false);
    expect(result.deployStatus).toBe('ERROR');
  });

  it('refuses to deploy when Vercel is not connected', async () => {
    await withVercel();
    await expect(vercelProvider.deploy(input, { context: { userId }, sleep: noSleep }))
      .rejects.toMatchObject({ code: 'DEPLOY_NOT_CONFIGURED' });
  });

  it('a dry run sends no request', async () => {
    await setConnection({ userId, provider: 'vercel', token: VTOKEN });
    const state = await withVercel();
    const result = await vercelProvider.deploy({ ...input, dryRun: true }, { context: { userId }, sleep: noSleep });
    expect(result.dryRun).toBe(true);
    expect(result.ok).toBe(true);
    expect(state.requests).toHaveLength(0);
  });
});
