/**
 * The MCP layer: registry, permissions, audit, and the guard ordering.
 *
 * These tests ARE the project's central claim. If they pass, "every agent
 * action goes through a schema-validated, permission-gated, fully audited tool
 * layer" is a fact rather than a sentence in a report.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { registerAllTools, EXPECTED_TOOLS } from '../src/mcp/tools/index.js';
import { TOOLS, describeRegistry, getTool } from '../src/mcp/registry.js';
import { GrantStore, RISK_CLASS, grantStore } from '../src/mcp/permissions.js';
import { canonicalise, hashInput, hostOf } from '../src/mcp/audit.js';
import { AuditEvent, OUTCOME } from '../src/models/AuditEvent.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';

const app = createApp({ logging: false });
let user;
let token;

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
});

afterAll(async () => { await disconnectTestDb(); });

beforeEach(async () => {
  await User.deleteMany({});
  await AuditEvent.collection.deleteMany({});
  grantStore.clear();
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Tester', email: 'mcp@example.com',
    password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  token = res.body.data.token;
  user = await User.findOne({ email: 'mcp@example.com' });
});

// ── Registry ─────────────────────────────────────────────────────────────────

describe('registry', () => {
  it('registers exactly the tools declared in tools/index.js', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('assigns the documented risk class to each tool', () => {
    const expected = {
      http_request: RISK_CLASS.NETWORK_READ,
      run_test_case: RISK_CLASS.NETWORK_READ,
      probe_sqli: RISK_CLASS.NETWORK_PROBE,
      probe_xss: RISK_CLASS.NETWORK_PROBE,
      probe_auth: RISK_CLASS.NETWORK_PROBE,
      probe_cors: RISK_CLASS.NETWORK_READ,
      probe_headers: RISK_CLASS.NETWORK_READ,
      parse_openapi: RISK_CLASS.LOCAL_COMPUTE,
      deploy_service: RISK_CLASS.DEPLOY_WRITE,
      fs_read: RISK_CLASS.LOCAL_FS_READ,
      code_search: RISK_CLASS.LOCAL_FS_READ,
      ast_extract: RISK_CLASS.LOCAL_COMPUTE,
      discover_routes: RISK_CLASS.LOCAL_FS_READ,
    };
    for (const [name, riskClass] of Object.entries(expected)) {
      expect(getTool(name)?.riskClass, name).toBe(riskClass);
    }
  });

  it('GENERATES JSON Schema from Zod, never hand-written', () => {
    for (const tool of describeRegistry()) {
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.$schema).toMatch(/json-schema\.org/);
    }
  });

  it('does not mark defaulted fields as required for callers', () => {
    // http_request.method has a default, so a caller need not supply it.
    const http = describeRegistry().find((t) => t.name === 'http_request');
    expect(http.inputSchema.required).toContain('url');
    expect(http.inputSchema.required ?? []).not.toContain('method');
  });

  it('refuses a duplicate tool name', async () => {
    const { defineTool } = await import('../src/mcp/registry.js');
    expect(() => defineTool({
      name: 'http_request', title: 'dupe', description: 'x',
      riskClass: RISK_CLASS.LOCAL_COMPUTE, handler: async () => ({}),
    })).toThrow(/already registered/);
  });
});

// ── Permissions ──────────────────────────────────────────────────────────────

describe('permission gate', () => {
  const ctx = { userId: 'u1', sessionId: 's1' };

  it('auto-grants local.compute: there is no network to consent to', () => {
    const store = new GrantStore();
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.LOCAL_COMPUTE }).allowed).toBe(true);
  });

  it('NEVER auto-grants network.probe', () => {
    const store = new GrantStore();
    const verdict = store.check({ ...ctx, riskClass: RISK_CLASS.NETWORK_PROBE, host: 'api.example.com' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/must approve/i);
  });

  it('grants network.read per host, not globally', () => {
    const store = new GrantStore();
    store.grant({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'a.example.com' });
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'a.example.com' }).allowed).toBe(true);
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'b.example.com' }).allowed).toBe(false);
  });

  it('scopes grants to a session: another session does not inherit them', () => {
    const store = new GrantStore();
    store.grant({ ...ctx, riskClass: RISK_CLASS.NETWORK_PROBE, host: 'a.example.com' });
    expect(store.check({ userId: 'u1', sessionId: 'OTHER', riskClass: RISK_CLASS.NETWORK_PROBE, host: 'a.example.com' }).allowed).toBe(false);
  });

  it('expires grants', () => {
    const store = new GrantStore({ ttlMs: 1000 });
    store.grant({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'a.example.com', now: 0 });
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'a.example.com', now: 500 }).allowed).toBe(true);
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'a.example.com', now: 2000 }).allowed).toBe(false);
  });

  it('requires confirmation for deploy.write, not merely a grant', () => {
    const store = new GrantStore();
    store.grant({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: false });
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE }).allowed).toBe(false);
    store.grant({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: true });
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE }).allowed).toBe(true);
  });

  it('revokes', () => {
    const store = new GrantStore();
    store.grant({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'a.example.com' });
    expect(store.revoke({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ })).toBe(1);
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.NETWORK_READ, host: 'a.example.com' }).allowed).toBe(false);
  });
});

// ── Audit ────────────────────────────────────────────────────────────────────

describe('audit hashing', () => {
  it('canonicalises key order, so the same call hashes the same', () => {
    expect(canonicalise({ b: 2, a: 1 })).toBe(canonicalise({ a: 1, b: 2 }));
    expect(hashInput({ b: 2, a: 1 })).toBe(hashInput({ a: 1, b: 2 }));
  });

  it('produces a different hash for different input', () => {
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });

  it('NEVER contains the raw input: a payload may carry credentials', () => {
    const secret = 'super-secret-token-value';
    const hash = hashInput({ headers: { authorization: secret } });
    expect(hash).not.toContain(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('extracts a host without throwing on a malformed URL', () => {
    expect(hostOf({ url: 'https://api.example.com:8443/x' })).toBe('api.example.com:8443');
    expect(hostOf({ url: 'not a url' })).toBeNull();
    expect(hostOf({})).toBeNull();
  });
});

describe('the audit collection is append-only', () => {
  async function seed() {
    return AuditEvent.create({
      tool: 'http_request', riskClass: RISK_CLASS.NETWORK_READ,
      inputHash: 'a'.repeat(64), outcome: OUTCOME.OK,
    });
  }

  it('refuses updateOne', async () => {
    await seed();
    await expect(AuditEvent.updateOne({}, { $set: { outcome: OUTCOME.DENIED } }))
      .rejects.toThrow(/append-only/);
  });

  it('refuses deleteMany', async () => {
    await seed();
    await expect(AuditEvent.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it('refuses findOneAndUpdate', async () => {
    await seed();
    await expect(AuditEvent.findOneAndUpdate({}, { $set: { tool: 'x' } }))
      .rejects.toThrow(/append-only/);
  });
});

// ── withGuards ordering: the architecture in one wrapper ─────────────────────

describe('withGuards', () => {
  const ctx = () => ({ userId: String(user._id), sessionId: 'sess-1', runId: 'run-1' });

  it('DENIES an ungranted network.probe call and audits the denial', async () => {
    const probe = getTool('probe_sqli');
    await expect(
      probe.handler({ url: 'https://api.example.com/x' }, ctx()),
    ).rejects.toThrow(/must approve/i);

    const rows = await AuditEvent.find({ tool: 'probe_sqli' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe(OUTCOME.DENIED);
    expect(rows[0].errorCode).toBe('PERMISSION_DENIED');
    expect(rows[0].targetHost).toBe('api.example.com');
  });

  it('permits the same call once the host is granted', async () => {
    grantStore.grant({
      userId: String(user._id), sessionId: 'sess-1',
      riskClass: RISK_CLASS.NETWORK_PROBE, host: 'api.example.com',
    });
    const probe = getTool('probe_sqli');
    const result = await probe.handler({ url: 'https://api.example.com/x' }, ctx());
    // api.example.com is not reachable from CI, so what matters here is that
    // the call was PERMITTED and produced a structured result rather than a
    // permission error.
    expect(result.family).toBe('sqli');
    expect(result).toHaveProperty('findings');

    const rows = await AuditEvent.find({ tool: 'probe_sqli' }).lean();
    expect(rows[0].outcome).toBe(OUTCOME.OK);
  });

  it('rejects malformed input BEFORE any I/O, and audits it', async () => {
    grantStore.grant({
      userId: String(user._id), sessionId: 'sess-1',
      riskClass: RISK_CLASS.LOCAL_COMPUTE,
    });
    const tool = getTool('parse_openapi');
    await expect(tool.handler({ spec: '' }, ctx())).rejects.toThrow(/Invalid input/);
    const rows = await AuditEvent.find({ tool: 'parse_openapi' }).lean();
    expect(rows[0].errorCode).toBe('VALIDATION_ERROR');
  });

  it('records an SSRF refusal as blocked_ssrf, not a generic error', async () => {
    grantStore.grant({
      userId: String(user._id), sessionId: 'sess-1',
      riskClass: RISK_CLASS.NETWORK_READ, host: '169.254.169.254',
    });
    const tool = getTool('http_request');
    await expect(
      tool.handler({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx()),
    ).rejects.toThrow();

    const rows = await AuditEvent.find({ tool: 'http_request' }).lean();
    expect(rows[0].outcome).toBe(OUTCOME.BLOCKED_SSRF);
    expect(rows[0].errorCode).toBe('BLOCKED_IP');
  });

  it('writes an audit row even when the handler throws', async () => {
    const before = await AuditEvent.countDocuments();
    const probe = getTool('probe_xss');
    await probe.handler({ url: 'https://nope.example.com/' }, ctx()).catch(() => {});
    expect(await AuditEvent.countDocuments()).toBe(before + 1);
  });

  it('AUDIT COUNT EQUALS TOOL-CALL COUNT (docs/01_PRD.md §7)', async () => {
    grantStore.grant({
      userId: String(user._id), sessionId: 'sess-1', riskClass: RISK_CLASS.LOCAL_COMPUTE,
    });
    const spec = JSON.stringify({
      openapi: '3.0.0', info: { title: 'T', version: '1' },
      paths: { '/x': { get: { responses: { 200: { description: 'ok' } } } } },
    });

    const calls = [
      () => getTool('parse_openapi').handler({ spec }, ctx()),
      () => getTool('parse_openapi').handler({ spec: '' }, ctx()),           // invalid
      () => getTool('probe_sqli').handler({ url: 'https://x.example.com/' }, ctx()), // denied
      () => getTool('parse_openapi').handler({ spec }, ctx()),
    ];
    for (const call of calls) await call().catch(() => {});

    expect(await AuditEvent.countDocuments()).toBe(calls.length);
  });

  it('stores a hash, never the raw payload', async () => {
    grantStore.grant({
      userId: String(user._id), sessionId: 'sess-1',
      riskClass: RISK_CLASS.NETWORK_PROBE, host: 'api.example.com',
    });
    await getTool('probe_sqli').handler(
      { url: 'https://api.example.com/x', headers: { authorization: 'Bearer SUPERSECRET' } },
      ctx(),
    );
    const rows = await AuditEvent.find({ tool: 'probe_sqli' }).lean();
    expect(JSON.stringify(rows)).not.toContain('SUPERSECRET');
    expect(rows[0].inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── HTTP surface ─────────────────────────────────────────────────────────────

describe('GET /api/mcp/tools', () => {
  it('returns every tool with generated schemas', async () => {
    const res = await request(app).get('/api/mcp/tools');
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(EXPECTED_TOOLS.length);
    expect(res.body.data.generatedFrom).toBe('zod');
    for (const t of res.body.data.tools) {
      expect(t.inputSchema.$schema, t.name).toMatch(/json-schema/);
      expect(t.riskClass).toBeTruthy();
    }
  });

  it('describes every risk class for the permission sheet', async () => {
    const res = await request(app).get('/api/mcp/tools');
    const names = res.body.data.riskClasses.map((c) => c.name).sort();
    expect(names).toEqual(
      ['deploy.write', 'local.compute', 'local.fs.read', 'network.probe', 'network.read'],
    );
    const probe = res.body.data.riskClasses.find((c) => c.name === 'network.probe');
    expect(probe.autoGranted).toBe(false);
  });
});

describe('GET /api/mcp/audit', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/mcp/audit')).status).toBe(401);
  });

  it('returns this user rows, filterable by outcome', async () => {
    await getTool('probe_sqli')
      .handler({ url: 'https://api.example.com/x' }, { userId: String(user._id), sessionId: 's' })
      .catch(() => {});

    const res = await request(app)
      .get('/api/mcp/audit?outcome=denied')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events.length).toBeGreaterThan(0);
    expect(res.body.data.events.every((e) => e.outcome === 'denied')).toBe(true);
  });

  it('exposes NO update or delete route', async () => {
    const put = await request(app).put('/api/mcp/audit').set('Authorization', `Bearer ${token}`);
    const del = await request(app).delete('/api/mcp/audit').set('Authorization', `Bearer ${token}`);
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });
});

describe('POST /api/mcp/grants', () => {
  it('requires authentication', async () => {
    expect((await request(app).post('/api/mcp/grants').send({ riskClass: 'network.read' })).status).toBe(401);
  });

  it('grants a risk class for a host and lists it back', async () => {
    const res = await request(app)
      .post('/api/mcp/grants')
      .set('Authorization', `Bearer ${token}`)
      .set('x-session-id', 'sheet-1')
      .send({ riskClass: 'network.probe', host: 'api.example.com' });
    expect(res.status).toBe(201);

    const list = await request(app)
      .get('/api/mcp/grants')
      .set('Authorization', `Bearer ${token}`)
      .set('x-session-id', 'sheet-1');
    expect(list.body.data.grants).toHaveLength(1);
    expect(list.body.data.grants[0].host).toBe('api.example.com');
  });

  it('rejects a host-requiring class with no host', async () => {
    const res = await request(app)
      .post('/api/mcp/grants')
      .set('Authorization', `Bearer ${token}`)
      .send({ riskClass: 'network.probe' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown risk class', async () => {
    const res = await request(app)
      .post('/api/mcp/grants')
      .set('Authorization', `Bearer ${token}`)
      .send({ riskClass: 'root.everything' });
    expect(res.status).toBe(400);
  });
});

describe('a later grant supersedes an earlier one, in both directions', () => {
  const ctx = { userId: 'u1', sessionId: 's1' };

  it('a later confirmation takes effect', () => {
    const store = new GrantStore();
    store.grant({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: false });
    store.grant({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: true });
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE }).allowed).toBe(true);
  });

  it('a later DOWNGRADE also takes effect: the dangerous direction', () => {
    const store = new GrantStore();
    store.grant({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: true });
    store.grant({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE, confirmed: false });
    expect(store.check({ ...ctx, riskClass: RISK_CLASS.DEPLOY_WRITE }).allowed).toBe(false);
  });
});
