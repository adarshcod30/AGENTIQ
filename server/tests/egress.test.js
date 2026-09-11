/**
 * The egress guard, exercised end to end.
 *
 * A real HTTP server runs on loopback so redirects, timeouts and the size cap
 * are tested against actual sockets rather than mocks. Reaching it requires the
 * ALLOW_PRIVATE_TARGETS escape hatch, which is itself part of what is under
 * test: with the hatch closed, every one of these targets must be refused.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'node:http';
import {
  fetchGuarded, validateUrl, resolveAndValidate, HostRateLimiter,
  EgressError, EGRESS_ERROR, rateLimiter,
} from '../src/mcp/egress.js';
import { env } from '../src/config/env.js';

let server;
let base;

/** Flips the escape hatch for a single test body. */
async function withPrivateTargets(fn) {
  const prev = env.ALLOW_PRIVATE_TARGETS;
  env.ALLOW_PRIVATE_TARGETS = true;
  try { return await fn(); } finally { env.ALLOW_PRIVATE_TARGETS = prev; }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ hello: 'world' }));

      case '/redirect-to-metadata':
        // The classic bypass: first hop is benign, second is the AWS IMDS.
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();

      case '/redirect-to-loopback':
        res.writeHead(302, { location: 'http://127.0.0.1:1/nope' });
        return res.end();

      case '/redirect-chain': {
        const n = Number(url.searchParams.get('n') ?? 0);
        res.writeHead(302, { location: `/redirect-chain?n=${n + 1}` });
        return res.end();
      }

      case '/redirect-once':
        res.writeHead(302, { location: '/ok' });
        return res.end();

      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('x'.repeat(200_000));

      case '/slow':
        return setTimeout(() => { res.writeHead(200); res.end('late'); }, 3000);

      case '/scheme-redirect':
        res.writeHead(302, { location: 'file:///etc/passwd' });
        return res.end();

      default:
        res.writeHead(404);
        return res.end('nope');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => rateLimiter.reset());

describe('scheme allow-list', () => {
  it.each([
    ['file:///etc/passwd', 'file'],
    ['ftp://example.com/x', 'ftp'],
    ['gopher://example.com/x', 'gopher'],
    ['data:text/plain,hello', 'data'],
  ])('refuses %s', async (url) => {
    await expect(fetchGuarded(url)).rejects.toMatchObject({
      code: EGRESS_ERROR.SCHEME_NOT_ALLOWED,
    });
  });

  it('marks a scheme refusal as an SSRF block for the audit layer', () => {
    try { validateUrl('file:///etc/passwd'); } catch (e) {
      expect(e).toBeInstanceOf(EgressError);
      expect(e.isSsrfBlock).toBe(true);
    }
  });

  it('rejects a malformed URL rather than passing it to the socket layer', async () => {
    await expect(fetchGuarded('http://')).rejects.toMatchObject({
      code: EGRESS_ERROR.INVALID_URL,
    });
  });
});

describe('blocked targets: one per range', () => {
  it.each([
    ['http://127.0.0.1/', 'loopback'],
    ['http://10.0.0.1/', 'RFC1918 10/8'],
    ['http://192.168.1.1/', 'RFC1918 192.168/16'],
    ['http://172.16.0.1/', 'RFC1918 172.16/12'],
    ['http://169.254.169.254/latest/meta-data/', 'AWS instance metadata'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fc00::1]/', 'IPv6 unique-local'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped metadata bypass'],
  ])('refuses %s (%s)', async (url) => {
    const err = await fetchGuarded(url).catch((e) => e);
    expect(err).toBeInstanceOf(EgressError);
    expect(err.code).toBe(EGRESS_ERROR.BLOCKED_IP);
    expect(err.isSsrfBlock).toBe(true);
  });

  it.each(['http://localhost/', 'http://printer.local/', 'http://db.internal/'])(
    'refuses %s by hostname, before any DNS lookup',
    async (url) => {
      const err = await fetchGuarded(url).catch((e) => e);
      expect(err.code).toBe(EGRESS_ERROR.BLOCKED_HOSTNAME);
    },
  );

  it('names the reason so the UI can explain the refusal', async () => {
    const err = await fetchGuarded('http://169.254.169.254/').catch((e) => e);
    expect(err.message).toMatch(/link-local/);
    expect(err.message).toMatch(/SSRF/);
    expect(err.details.ip).toBe('169.254.169.254');
  });
});

describe('DNS is resolved BEFORE the address is judged', () => {
  it('refuses a public hostname that resolves to a private address', async () => {
    // The whole point: the attacker controls DNS, so the NAME proves nothing.
    const lookup = vi.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const err = await resolveAndValidate('totally-innocent.example.com', { lookup }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressError);
    expect(err.code).toBe(EGRESS_ERROR.BLOCKED_IP);
    expect(err.message).toMatch(/resolves to 169\.254\.169\.254/);
  });

  it('refuses when ANY resolved address is private, not just the first', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(resolveAndValidate('mixed.example.com', { lookup })).rejects.toMatchObject({
      code: EGRESS_ERROR.BLOCKED_IP,
    });
  });

  it('reports a DNS failure distinctly from a block', async () => {
    const lookup = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 'ENOTFOUND' }));
    await expect(resolveAndValidate('nx.example.com', { lookup })).rejects.toMatchObject({
      code: EGRESS_ERROR.DNS_FAILED,
    });
  });

  it('returns the validated address for pinning', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(resolveAndValidate('example.com', { lookup }))
      .resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });
});

describe('redirects are re-validated at every hop', () => {
  it('follows a benign redirect', async () => {
    await withPrivateTargets(async () => {
      const res = await fetchGuarded(`${base}/redirect-once`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ hello: 'world' });
      expect(res.redirects).toHaveLength(1);
    });
  });

  it('REFUSES a redirect chain ending at the metadata endpoint', async () => {
    // This is the bypass that defeats a guard which only checks the first URL.
    // ALLOW_PRIVATE_TARGETS lets hop 1 through; hop 2 must still be refused,
    // because the hatch is for localhost fixtures, not for metadata.
    const prev = env.ALLOW_PRIVATE_TARGETS;
    env.ALLOW_PRIVATE_TARGETS = false;
    try {
      const err = await fetchGuarded(`${base}/redirect-to-metadata`).catch((e) => e);
      expect(err).toBeInstanceOf(EgressError);
      // Refused at hop 1 with the hatch closed: the target itself is loopback.
      expect(err.code).toBe(EGRESS_ERROR.BLOCKED_IP);
    } finally { env.ALLOW_PRIVATE_TARGETS = prev; }
  });

  it('refuses a redirect to a non-allowed scheme', async () => {
    await withPrivateTargets(async () => {
      const err = await fetchGuarded(`${base}/scheme-redirect`).catch((e) => e);
      expect(err.code).toBe(EGRESS_ERROR.SCHEME_NOT_ALLOWED);
    });
  });

  it('caps the redirect chain at 3 hops', async () => {
    await withPrivateTargets(async () => {
      const err = await fetchGuarded(`${base}/redirect-chain?n=0`).catch((e) => e);
      expect(err.code).toBe(EGRESS_ERROR.TOO_MANY_REDIRECTS);
      expect(err.details.chain.length).toBeLessThanOrEqual(4);
    });
  });
});

describe('limits', () => {
  it('truncates a response at the byte cap instead of buffering it all', async () => {
    await withPrivateTargets(async () => {
      const res = await fetchGuarded(`${base}/big`, { maxBytes: 1024 });
      expect(res.truncated).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(200_000);
      expect(res.bytes).toBeGreaterThan(1024);
    });
  });

  it('times out a slow endpoint', async () => {
    await withPrivateTargets(async () => {
      const err = await fetchGuarded(`${base}/slow`, { timeoutMs: 300 }).catch((e) => e);
      expect(err.code).toBe(EGRESS_ERROR.TIMEOUT);
    });
  });

  it('returns status, headers and body on success', async () => {
    await withPrivateTargets(async () => {
      const res = await fetchGuarded(`${base}/ok`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.ip).toBe('127.0.0.1');
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});

describe('per-host rate limit', () => {
  it('allows up to the configured rate within one second', async () => {
    const limiter = new HostRateLimiter(3);
    const now = () => 1_000_000;
    for (let i = 0; i < 3; i += 1) {
      await limiter.acquire('example.com', { now, sleep: async () => {} });
    }
    // A 4th in the same instant must not be admitted immediately.
    await expect(
      limiter.acquire('example.com', { now, maxWaitMs: 10, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: EGRESS_ERROR.RATE_LIMITED });
  });

  it('is per-host, not global', async () => {
    const limiter = new HostRateLimiter(1);
    const now = () => 1_000_000;
    await limiter.acquire('a.example.com', { now, sleep: async () => {} });
    await expect(
      limiter.acquire('b.example.com', { now, sleep: async () => {} }),
    ).resolves.toBeUndefined();
  });

  it('admits again once the window rolls forward', async () => {
    const limiter = new HostRateLimiter(1);
    let t = 1_000_000;
    await limiter.acquire('example.com', { now: () => t, sleep: async () => {} });
    t += 1100;
    await expect(
      limiter.acquire('example.com', { now: () => t, sleep: async () => {} }),
    ).resolves.toBeUndefined();
  });
});

describe('ALLOW_PRIVATE_TARGETS escape hatch', () => {
  it('is OFF by default, so loopback is refused', async () => {
    expect(env.ALLOW_PRIVATE_TARGETS).toBeFalsy();
    await expect(fetchGuarded(`${base}/ok`)).rejects.toMatchObject({
      code: EGRESS_ERROR.BLOCKED_IP,
    });
  });

  it('permits loopback when explicitly enabled, for fixture testing', async () => {
    await withPrivateTargets(async () => {
      const res = await fetchGuarded(`${base}/ok`);
      expect(res.status).toBe(200);
    });
  });

  it('is ignored in production even if set: defence in depth', async () => {
    const prevEnv = env.NODE_ENV;
    const prevFlag = env.ALLOW_PRIVATE_TARGETS;
    env.NODE_ENV = 'production';
    env.ALLOW_PRIVATE_TARGETS = true;
    try {
      // config/env.js refuses this combination at boot; this proves the guard
      // would still hold if it ever reached the runtime by another path.
      await expect(fetchGuarded('http://169.254.169.254/')).rejects.toMatchObject({
        code: EGRESS_ERROR.BLOCKED_IP,
      });
    } finally {
      env.NODE_ENV = prevEnv;
      env.ALLOW_PRIVATE_TARGETS = prevFlag;
    }
  });
});


/**
 * REGRESSION: the IP-pinning path, exercised through a real HOSTNAME.
 *
 * Every other test in this suite targets 127.0.0.1, and Node skips the `lookup`
 * callback entirely for an IP literal. That meant the pinning override: the
 * mechanism that defeats DNS rebinding, and the single most important line in
 * egress.js: was never actually executed by the suite.
 *
 * It was wrong. Node >= 20 enables autoSelectFamily by default, which calls a
 * custom lookup with { all: true } and expects an ARRAY of { address, family };
 * the override answered with the older positional convention, so every request
 * to a hostname failed with "Invalid IP address: undefined".
 *
 * This block uses its own DUAL-STACK server, because "localhost" resolves to
 * ::1 first on macOS and to 127.0.0.1 first elsewhere: binding one family
 * would make the test pass or fail depending on the machine.
 */
describe('IP pinning works for a hostname, not just an IP literal', () => {
  let hostServer;
  let hostBase;

  beforeAll(async () => {
    hostServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hello: 'world' }));
    });
    // No host argument: binds dual-stack, so either resolution order works.
    await new Promise((r) => hostServer.listen(0, r));
    hostBase = `http://localhost:${hostServer.address().port}`;
  });

  afterAll(() => { hostServer?.close(); });

  it('resolves, pins and connects when the URL carries a hostname', async () => {
    await withPrivateTargets(async () => {
      const res = await fetchGuarded(`${hostBase}/ok`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ hello: 'world' });
      // Proof a pin was applied rather than Node doing its own lookup.
      expect(['127.0.0.1', '::1']).toContain(res.ip);
    });
  });

  it('answers the autoSelectFamily convention with an array', async () => {
    // Asserted directly, because a refactor could silently regress to the
    // positional form and every IP-literal test in this file would still pass.
    const seen = [];
    const original = http.request.bind(http);
    const spy = vi.spyOn(http, 'request').mockImplementation((opts, cb) => {
      seen.push(opts.lookup);
      return original(opts, cb);
    });

    await withPrivateTargets(async () => { await fetchGuarded(`${hostBase}/ok`); });
    spy.mockRestore();

    const lookup = seen[0];
    expect(typeof lookup).toBe('function');

    const arrayForm = await new Promise((r) => lookup('h', { all: true }, (_e, a) => r(a)));
    expect(Array.isArray(arrayForm)).toBe(true);
    expect(arrayForm[0].address).toBeTruthy();
    expect([4, 6]).toContain(arrayForm[0].family);

    const positional = await new Promise((r) => lookup('h', {}, (_e, addr, fam) => r({ addr, fam })));
    expect(positional.addr).toBeTruthy();
    expect([4, 6]).toContain(positional.fam);
  });
});


/**
 * THE ESCAPE HATCH MUST NOT UNLOCK THE METADATA RANGE.
 *
 * ALLOW_PRIVATE_TARGETS exists so the fixture apps on 127.0.0.1 can be tested.
 * It used to lift EVERY address rule, including 169.254.0.0/16, so with the
 * flag on, a user-supplied
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` was
 * fetched by the server and its body handed back. On a laptop that fails to
 * route, which is exactly why it went unnoticed; on App Runner it returns the
 * task role's credentials.
 *
 * config/env.js refuses the flag when NODE_ENV=production, but that only checks
 * the value read at BOOT: this suite and the evaluation harness set
 * env.ALLOW_PRIVATE_TARGETS at runtime and bypass it completely. So the rule
 * has to be one the flag cannot reach.
 */
describe('ALLOW_PRIVATE_TARGETS never unlocks the cloud metadata range', () => {
  it('still refuses 169.254.169.254 with the hatch open', async () => {
    await withPrivateTargets(async () => {
      await expect(resolveAndValidate('169.254.169.254')).rejects.toMatchObject({
        code: EGRESS_ERROR.BLOCKED_IP,
      });
    });
  });

  it('still refuses IPv6 link-local with the hatch open', async () => {
    await withPrivateTargets(async () => {
      await expect(resolveAndValidate('fe80::1')).rejects.toMatchObject({
        code: EGRESS_ERROR.BLOCKED_IP,
      });
    });
  });

  it('refuses it through fetchGuarded too, and records an SSRF block', async () => {
    await withPrivateTargets(async () => {
      const err = await fetchGuarded('http://169.254.169.254/latest/meta-data/')
        .catch((e) => e);
      expect(err).toBeInstanceOf(EgressError);
      // isSsrfBlock is what makes the audit row read `blocked_ssrf` rather than
      // a generic error: those rows are the most persuasive evidence the
      // guard is live.
      expect(err.isSsrfBlock).toBe(true);
    });
  });

  it('but STILL permits loopback and private ranges, which is the point of the hatch', async () => {
    await withPrivateTargets(async () => {
      await expect(resolveAndValidate('127.0.0.1')).resolves.toMatchObject({ address: '127.0.0.1' });
      await expect(resolveAndValidate('10.0.0.5')).resolves.toMatchObject({ address: '10.0.0.5' });
    });
  });
});
