/**
 * /api/request/send: the API client (docs/01_PRD.md F8).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * This route's whole job is "fetch whatever URL the user typed". Handed
 * straight to an HTTP client, a POST with
 * http://169.254.169.254/latest/meta-data/iam/security-credentials/ would make
 * the server fetch the cloud metadata endpoint and return the body to the
 * caller: the exact attack server/src/mcp/egress.js exists to prevent,
 * reachable through the front door of the product.
 *
 * The route goes through the `http_request` MCP tool like everything else.
 * These tests pin that down at the HTTP boundary, where a future refactor would
 * be tempted to "just use axios, it's simpler".
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { grantStore, RISK_CLASS } from '../src/mcp/permissions.js';
import { AuditEvent, OUTCOME } from '../src/models/AuditEvent.js';
import { User } from '../src/models/User.js';
import { env } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { app as hardenedApp } from '../../fixtures/hardened-api/server.js';

const app = createApp({ logging: false });
const SESSION = 'request-route-test';
let token;
let user;
let fixtureUrl;
let fixtureServer;

const auth = (r) => r.set('Authorization', `Bearer ${token}`).set('x-session-id', SESSION);

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
  await new Promise((resolve) => {
    fixtureServer = hardenedApp.listen(0, '127.0.0.1', () => {
      fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
      resolve();
    });
  });
  env.ALLOW_PRIVATE_TARGETS = true;
});

afterAll(async () => {
  env.ALLOW_PRIVATE_TARGETS = false;
  fixtureServer?.close();
  await disconnectTestDb();
});

beforeEach(async () => {
  await User.deleteMany({});
  await AuditEvent.collection.deleteMany({});
  grantStore.clear();
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Client', email: 'client@example.com',
    password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  token = res.body.data.token;
  user = await User.findOne({ email: 'client@example.com' });
});

const grantHost = (url) => grantStore.grant({
  userId: user._id, sessionId: SESSION,
  riskClass: RISK_CLASS.NETWORK_READ, host: new URL(url).host,
});

describe('the API client cannot be used as an SSRF proxy', () => {
  it('REGRESSION: refuses the cloud metadata endpoint even when the host is granted', async () => {
    // Granting the host is the strongest form of the test: the permission gate
    // is satisfied, so only the egress guard can still refuse. The old
    // controller had neither and returned the credentials.
    grantStore.grant({
      userId: user._id, sessionId: SESSION,
      riskClass: RISK_CLASS.NETWORK_READ, host: '169.254.169.254',
    });

    const res = await auth(request(app).post('/api/request/send'))
      .send({ url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BLOCKED_IP');
    expect(res.body.error.message).toMatch(/metadata/i);
  });

  it('records the refusal as blocked_ssrf, not a generic error', async () => {
    grantStore.grant({
      userId: user._id, sessionId: SESSION,
      riskClass: RISK_CLASS.NETWORK_READ, host: '169.254.169.254',
    });
    await auth(request(app).post('/api/request/send'))
      .send({ url: 'http://169.254.169.254/latest/meta-data/' });

    const rows = await AuditEvent.find({ outcome: OUTCOME.BLOCKED_SSRF }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('http_request');
    expect(String(rows[0].userId)).toBe(String(user._id));
  });

  it.each(['file:///etc/passwd', 'gopher://x/', 'data:text/plain,hi'])(
    'refuses %s at the boundary, with a reason that names the scheme', async (url) => {
      // The egress guard would refuse these anyway, but a file: URL has no host
      // so it used to be denied for want of a grant: a baffling message when
      // the real answer is that the scheme can never be allowed.
      const res = await auth(request(app).post('/api/request/send')).send({ url });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/http and https/i);
    });
});

describe('the permission gate applies here too', () => {
  it('asks for a grant instead of silently fetching', async () => {
    const res = await auth(request(app).post('/api/request/send'))
      .send({ url: `${fixtureUrl}/users/1` });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    expect(res.body.error.details.needsGrant[0]).toMatchObject({ riskClass: 'network.read' });
  });

  it('requires authentication before anything else', async () => {
    const res = await request(app).post('/api/request/send').send({ url: 'not-a-url' });
    // 401, not 400: auth is the cheapest check and runs first. The previous
    // ordering validated the body for anonymous callers.
    expect(res.status).toBe(401);
  });
});

describe('a permitted request', () => {
  it('returns the tool result shape the UI expects', async () => {
    grantHost(fixtureUrl);
    const res = await auth(request(app).post('/api/request/send'))
      .send({ url: `${fixtureUrl}/users/1`, method: 'GET' });

    expect(res.status).toBe(200);
    const { data } = res.body;
    // The old controller returned { data, time }; the UI reads { body, durationMs,
    // bytes, ip }. The contract was broken as well as unsafe.
    expect(data).toMatchObject({ status: 200, ip: '127.0.0.1' });
    expect(typeof data.body).toBe('string');
    expect(typeof data.bytes).toBe('number');
    expect(typeof data.durationMs).toBe('number');
    expect(JSON.parse(data.body)).toMatchObject({ id: 1 });
  });

  it('writes an ok audit row naming the tool and the user', async () => {
    grantHost(fixtureUrl);
    await auth(request(app).post('/api/request/send')).send({ url: `${fixtureUrl}/users/1` });

    const rows = await AuditEvent.find({ outcome: OUTCOME.OK }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('http_request');
    expect(rows[0].targetHost).toBe(new URL(fixtureUrl).host);
  });

  it('validates the URL', async () => {
    const res = await auth(request(app).post('/api/request/send')).send({ url: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
