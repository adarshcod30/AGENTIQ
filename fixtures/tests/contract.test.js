/**
 * The shared contract suite.
 *
 * This is the most important file in fixtures/. The security agent's precision
 * is measured as "findings on hardened-api", and its recall as "findings on
 * vulnerable-api". That comparison is only meaningful if the two apps are
 * identical apart from their defects. Otherwise a finding on one and not the
 * other could be explained by an incidental difference, and the evaluation's
 * numbers would be uninterpretable.
 *
 * Every non-attack request below is sent to BOTH apps and the responses are
 * asserted equal. A divergence introduced by accident fails the build.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app as vulnerable } from '../vulnerable-api/server.js';
import { app as hardened } from '../hardened-api/server.js';
import { ADMIN_TOKEN, USERS, ITEMS } from '../shared/data.js';

const APPS = [['vulnerable', vulnerable], ['hardened', hardened]];

/** Sends the same request to both apps and returns both responses. */
async function both(send) {
  return { v: await send(vulnerable), h: await send(hardened) };
}

describe('identical contract on benign traffic', () => {
  it('GET /users/:id returns the same body and status', async () => {
    const { v, h } = await both((app) => request(app).get('/users/1'));
    expect(v.status).toBe(200);
    expect(h.status).toBe(200);
    expect(v.body).toEqual(h.body);
    expect(v.body).toEqual({
      id: 1, username: 'alice', email: 'alice@example.com', role: 'user',
    });
  });

  it('never returns the password column on the public route', async () => {
    for (const [name, app] of APPS) {
      const res = await request(app).get('/users/1');
      expect(res.body, name).not.toHaveProperty('password');
    }
  });

  it('GET /users/:id 404s identically for a missing user', async () => {
    const { v, h } = await both((app) => request(app).get('/users/999'));
    expect(v.status).toBe(404);
    expect(h.status).toBe(404);
    expect(v.body).toEqual(h.body);
  });

  it('GET /items returns the same list', async () => {
    const { v, h } = await both((app) => request(app).get('/items'));
    expect(v.body).toEqual(h.body);
    expect(v.body).toHaveLength(ITEMS.length);
  });

  it('GET /items?ownerId=1 filters identically', async () => {
    const { v, h } = await both((app) => request(app).get('/items?ownerId=1'));
    expect(v.body).toEqual(h.body);
    expect(v.body.every((i) => i.ownerId === 1)).toBe(true);
  });

  it('POST /login succeeds identically', async () => {
    const { v, h } = await both((app) =>
      request(app).post('/login').send({ username: 'alice', password: 'alice-pw' }));
    expect(v.status).toBe(200);
    expect(v.body).toEqual(h.body);
    expect(v.body.token).toBe(ADMIN_TOKEN);
  });

  it('POST /login fails identically on bad credentials', async () => {
    const { v, h } = await both((app) =>
      request(app).post('/login').send({ username: 'alice', password: 'wrong' }));
    expect(v.status).toBe(401);
    expect(h.status).toBe(401);
    expect(v.body).toEqual(h.body);
  });

  it('GET /health has the same shape, differing only in `variant`', async () => {
    const { v, h } = await both((app) => request(app).get('/health'));
    expect(Object.keys(v.body).sort()).toEqual(Object.keys(h.body).sort());
    expect(v.body.variant).toBe('vulnerable');
    expect(h.body.variant).toBe('hardened');
  });

  it('unknown routes 404 identically', async () => {
    const { v, h } = await both((app) => request(app).get('/nope'));
    expect(v.status).toBe(404);
    expect(h.status).toBe(404);
    expect(v.body).toEqual(h.body);
  });

  it('GET /search returns HTML from both for a benign term', async () => {
    const { v, h } = await both((app) => request(app).get('/search?q=widget'));
    expect(v.headers['content-type']).toMatch(/html/);
    expect(h.headers['content-type']).toMatch(/html/);
    // Benign input contains nothing to escape, so the pages are byte-identical.
    expect(v.text).toBe(h.text);
  });

  it('GET /fetch returns the same preview for an allowed URL', async () => {
    const { v, h } = await both((app) => request(app).get('/fetch?url=https://example.com/'));
    expect(v.status).toBe(200);
    expect(h.status).toBe(200);
    expect(v.body).toEqual(h.body);
    expect(v.body).toMatchObject({ url: 'https://example.com/', ok: true });
  });

  it('GET /go bounces the same way for a same-site path', async () => {
    const { v, h } = await both((app) => request(app).get('/go?next=/dashboard'));
    expect(v.status).toBe(302);
    expect(h.status).toBe(302);
    expect(v.headers.location).toBe('/dashboard');
    expect(h.headers.location).toBe('/dashboard');
  });
});

// ── The defects. Each is what a probe family must detect. ────────────────────

describe('DEFECT 1: SQL injection', () => {
  it('vulnerable leaks a database error; hardened does not', async () => {
    const payload = "1 OR 1=1--";
    const v = await request(vulnerable).get(`/users/${encodeURIComponent(payload)}`);
    const h = await request(hardened).get(`/users/${encodeURIComponent(payload)}`);

    // The vulnerable app either executes the injection or leaks the driver error.
    const vLeaks = v.status === 500 && /SQLITE|syntax/i.test(JSON.stringify(v.body));
    const vInjected = v.status === 200;
    expect(vLeaks || vInjected, 'vulnerable must be injectable').toBe(true);

    // The hardened app rejects it cleanly and reveals nothing about the engine.
    expect(h.status).toBe(400);
    expect(JSON.stringify(h.body)).not.toMatch(/SQLITE|SELECT|syntax/i);
  });

  it('vulnerable echoes the SQL statement back; hardened never does', async () => {
    const v = await request(vulnerable).get('/users/abc');
    expect(JSON.stringify(v.body)).toMatch(/SELECT/i);
    const h = await request(hardened).get('/users/abc');
    expect(JSON.stringify(h.body)).not.toMatch(/SELECT/i);
  });
});

describe('DEFECT 2: reflected XSS', () => {
  const PAYLOAD = '<script>alert(1)</script>';

  it('vulnerable reflects the payload unescaped', async () => {
    const res = await request(vulnerable).get(`/search?q=${encodeURIComponent(PAYLOAD)}`);
    expect(res.text).toContain(PAYLOAD);
  });

  it('hardened escapes it', async () => {
    const res = await request(hardened).get(`/search?q=${encodeURIComponent(PAYLOAD)}`);
    expect(res.text).not.toContain(PAYLOAD);
    expect(res.text).toContain('&lt;script&gt;');
  });
});

describe('DEFECT 3: broken authentication', () => {
  it('vulnerable serves /admin/users anonymously, passwords included', async () => {
    const res = await request(vulnerable).get('/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(USERS.length);
    expect(res.body.users[0]).toHaveProperty('password');
  });

  it('hardened requires a bearer token', async () => {
    expect((await request(hardened).get('/admin/users')).status).toBe(401);
  });

  it('hardened serves it WITH a token, and still omits passwords', async () => {
    const res = await request(hardened)
      .get('/admin/users').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(USERS.length);
    expect(res.body.users[0]).not.toHaveProperty('password');
  });
});

describe('DEFECT 4: CORS', () => {
  it('vulnerable sends ACAO:* together with credentials', async () => {
    const res = await request(vulnerable).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('hardened does not reflect an untrusted origin', async () => {
    const res = await request(hardened).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('hardened allows its one configured origin', async () => {
    const res = await request(hardened).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('DEFECT 5: security headers', () => {
  const REQUIRED = [
    'strict-transport-security',
    'content-security-policy',
    'x-content-type-options',
    'x-frame-options',
  ];

  it('vulnerable sets none of them, and leaks x-powered-by', async () => {
    const res = await request(vulnerable).get('/health');
    for (const h of REQUIRED) expect(res.headers[h], h).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeDefined();
  });

  it('hardened sets all of them, and hides x-powered-by', async () => {
    const res = await request(hardened).get('/health');
    for (const h of REQUIRED) expect(res.headers[h], h).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('DEFECT 6: rate limiting', () => {
  it('vulnerable advertises no rate-limit headers', async () => {
    const res = await request(vulnerable).get('/health');
    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit']).toBeUndefined();
  });

  it('hardened advertises a limit', async () => {
    const res = await request(hardened).get('/health');
    const advertised = res.headers['ratelimit-limit'] ?? res.headers['ratelimit'];
    expect(advertised).toBeDefined();
  });
});

describe('DEFECT 7: SSRF', () => {
  const METADATA = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';

  it('vulnerable fetches the metadata address and leaks credentials', async () => {
    const res = await request(vulnerable).get(`/fetch?url=${encodeURIComponent(METADATA)}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toMatch(/AccessKeyId|security-credentials|"Code":"Success"/);
  });

  it('hardened refuses the internal host without fetching it', async () => {
    const res = await request(hardened).get(`/fetch?url=${encodeURIComponent(METADATA)}`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/AccessKeyId|security-credentials/);
  });
});

describe('DEFECT 8: open redirect', () => {
  const OFFSITE = 'https://evil.example/phish';

  it('vulnerable sends the browser off-site', async () => {
    const res = await request(vulnerable).get(`/go?next=${encodeURIComponent(OFFSITE)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(OFFSITE);
  });

  it('hardened falls back to a same-site path', async () => {
    const res = await request(hardened).get(`/go?next=${encodeURIComponent(OFFSITE)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});
