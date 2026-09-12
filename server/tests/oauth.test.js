/**
 * OAuth "Connect" flows. The provider redirect to a real consent screen cannot
 * be automated, but everything on our side is: the authorize URL and its signed
 * state, and a full callback that exchanges a code against a fake token endpoint
 * and stores the connection. Confirms the CSRF state is required and that an
 * unconfigured provider is refused.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { listen } from './helpers/fakeProviders.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Connection } from '../src/models/Connection.js';
import { getConnectionToken } from '../src/services/connections.service.js';
import { oauthProviders, oauthStartUrl } from '../src/services/oauth.service.js';
import { env } from '../src/config/env.js';

const app = createApp({ logging: false });
const servers = [];
let token;
let userId;

/** A fake OAuth token endpoint that returns an access token for any code. */
function fakeTokenServer(accessToken = 'gho_fake_access_token_123') {
  const a = express();
  a.use(express.urlencoded({ extended: false }));
  a.use(express.json());
  a.post('/token', (req, res) => res.json({ access_token: accessToken, token_type: 'bearer' }));
  return a;
}

beforeAll(async () => {
  await connectTestDb();
  env.ALLOW_PRIVATE_TARGETS = true; // the fake token endpoint is on loopback
  const { server, url } = await listen(fakeTokenServer());
  servers.push(server);
  process.env.GITHUB_OAUTH_CLIENT_ID = 'gh_client_123';
  process.env.GITHUB_OAUTH_CLIENT_SECRET = 'gh_secret_456';
  process.env.GITHUB_OAUTH_TOKEN_URL = `${url}/token`;
});
afterAll(async () => {
  env.ALLOW_PRIVATE_TARGETS = false;
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env.GITHUB_OAUTH_TOKEN_URL;
  for (const s of servers) s.close();
  await disconnectTestDb();
});
beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Connection.deleteMany({})]);
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Dev', email: 'oauth@example.com', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  token = res.body.data.token;
  userId = (await User.findOne({ email: 'oauth@example.com' }))._id;
});

describe('oauth config', () => {
  it('reports github configured and vercel not (no client id), render has no OAuth', () => {
    const p = oauthProviders();
    expect(p.github).toBe(true);
    expect(p.vercel).toBe(false);
    expect(p.render).toBeUndefined();
  });

  it('builds an authorize url with client id, redirect, scope and a state', () => {
    const url = new URL(oauthStartUrl({ provider: 'github', userId }));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('gh_client_123');
    expect(url.searchParams.get('scope')).toBe('repo');
    expect(url.searchParams.get('redirect_uri')).toContain('/api/connections/github/oauth/callback');
    expect(url.searchParams.get('state')).toBeTruthy();
  });
});

describe('oauth routes', () => {
  it('start returns an authorize url; a full callback stores the connection', async () => {
    const start = await request(app).post('/api/connections/github/oauth/start').set('Authorization', `Bearer ${token}`);
    expect(start.status).toBe(200);
    const state = new URL(start.body.data.url).searchParams.get('state');

    const cb = await request(app).get(`/api/connections/github/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('/settings?connected=github');

    expect(await getConnectionToken({ userId, provider: 'github' })).toBe('gho_fake_access_token_123');
  });

  it('start 400s for a provider with no OAuth app (render)', async () => {
    const res = await request(app).post('/api/connections/render/oauth/start').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('callback redirects with an error on a bad state', async () => {
    const cb = await request(app).get('/api/connections/github/oauth/callback?code=abc&state=not-a-jwt');
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('connect_error=');
  });
});
