/**
 * THE EGRESS GUARD: the most important security control in the system.
 *
 * AGENTIQ accepts a URL from a user and fetches it from the server. Without
 * controls that is a textbook SSRF proxy: a user asks it to fetch
 * http://169.254.169.254/latest/meta-data/iam/security-credentials/ and the
 * task role's AWS credentials leave the building. Since docs/05_AWS_ARCHITECTURE.md
 * moved deployment to AWS, that is not a hypothetical: it is the account this
 * project runs in.
 *
 * EVERY outbound request from every tool goes through fetchGuarded(). The
 * architecture test (server/tests/architecture.test.js) exists so that no agent
 * can quietly acquire its own axios import and bypass this file.
 *
 * Order of operations, per docs/02_TRD.md §7:
 *   1. scheme allow-list (http, https)
 *   2. hostname suffix block (.local, .internal, localhost)
 *   3. resolve DNS -> validate EVERY resolved address
 *   4. PIN the chosen IP for the actual connection (defeats DNS rebinding)
 *   5. per-host rate limit
 *   6. request with timeout, manual redirects (max 3), re-validating each hop
 *   7. streamed response with a hard byte cap
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { classifyIp, isBlockedHostname, isNeverAllowed } from './ipRules.js';
import { env } from '../config/env.js';

export const EGRESS_ERROR = {
  SCHEME_NOT_ALLOWED: 'SCHEME_NOT_ALLOWED',
  BLOCKED_HOSTNAME: 'BLOCKED_HOSTNAME',
  BLOCKED_IP: 'BLOCKED_IP',
  DNS_FAILED: 'DNS_FAILED',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INVALID_URL: 'INVALID_URL',
};

/**
 * A refusal by the guard. Distinguishable from a transport failure so the audit
 * layer can record `blocked_ssrf` rather than a generic error, and so the UI can
 * explain *why* rather than showing a stack trace.
 */
export class EgressError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EgressError';
    this.code = code;
    this.details = details;
    this.isSsrfBlock = [
      EGRESS_ERROR.BLOCKED_IP,
      EGRESS_ERROR.BLOCKED_HOSTNAME,
      EGRESS_ERROR.SCHEME_NOT_ALLOWED,
    ].includes(code);
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** True when private targets are permitted: local fixture testing only. */
export function privateTargetsAllowed() {
  // The schema already refuses ALLOW_PRIVATE_TARGETS=true in production
  // (config/env.js), so this is defence in depth rather than the only check.
  return Boolean(env.ALLOW_PRIVATE_TARGETS) && env.NODE_ENV !== 'production';
}

// ── Step 1 & 2: URL shape ────────────────────────────────────────────────────

export function validateUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new EgressError(EGRESS_ERROR.INVALID_URL, `Not a valid URL: ${rawUrl}`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    // file:, gopher:, ftp:, data: are all SSRF vectors in their own right.
    throw new EgressError(
      EGRESS_ERROR.SCHEME_NOT_ALLOWED,
      `Only http and https are allowed. Refused scheme: ${url.protocol.replace(':', '')}`,
      { scheme: url.protocol },
    );
  }

  if (!privateTargetsAllowed() && isBlockedHostname(url.hostname)) {
    throw new EgressError(
      EGRESS_ERROR.BLOCKED_HOSTNAME,
      `Refused hostname "${url.hostname}": internal namespaces are blocked to prevent SSRF.`,
      { hostname: url.hostname },
    );
  }

  return url;
}

// ── Step 3: resolve, then validate the RESOLVED address ──────────────────────

/**
 * Validating the hostname is not enough: an attacker controls DNS and can
 * point evil.com at 127.0.0.1. So resolve first, then judge the address.
 *
 * Every returned address is checked, not just the one we intend to use: a host
 * that resolves to one public and one private address must not be reachable.
 */
export async function resolveAndValidate(rawHostname, { lookup = dns.lookup } = {}) {
  // WHATWG URL keeps the brackets on an IPv6 host: new URL('http://[::1]/')
  // gives hostname '[::1]'. isIP() rejects that, so without stripping them a
  // bracketed literal would skip IP classification entirely and fall through to
  // a DNS lookup: the wrong code path for a security decision.
  const hostname = String(rawHostname).replace(/^\[|\]$/g, '');

  // A literal IP in the URL skips DNS but still gets classified.
  if (isIP(hostname)) {
    const verdict = classifyIp(hostname);
    // isNeverAllowed outranks the escape hatch: the cloud metadata range stays
    // blocked even when private targets are permitted for fixture testing.
    if (verdict.blocked && (!privateTargetsAllowed() || isNeverAllowed(verdict))) {
      throw new EgressError(
        EGRESS_ERROR.BLOCKED_IP,
        `Refused ${hostname}: ${verdict.reason}. Private and link-local addresses are blocked to prevent SSRF.`,
        { ip: hostname, reason: verdict.reason },
      );
    }
    return { address: hostname, family: verdict.family };
  }

  let records;
  try {
    records = await lookup(hostname, { all: true });
  } catch (err) {
    throw new EgressError(
      EGRESS_ERROR.DNS_FAILED,
      `Could not resolve ${hostname}: ${err.code ?? err.message}`,
      { hostname },
    );
  }

  if (!records?.length) {
    throw new EgressError(EGRESS_ERROR.DNS_FAILED, `No addresses for ${hostname}`, { hostname });
  }

  for (const record of records) {
    const verdict = classifyIp(record.address);
    if (verdict.blocked && (!privateTargetsAllowed() || isNeverAllowed(verdict))) {
      throw new EgressError(
        EGRESS_ERROR.BLOCKED_IP,
        `Refused ${hostname}: it resolves to ${record.address} (${verdict.reason}). ` +
          'Private and link-local addresses are blocked to prevent SSRF.',
        { hostname, ip: record.address, reason: verdict.reason },
      );
    }
  }

  return { address: records[0].address, family: records[0].family };
}

// ── Step 5: per-host rate limit ──────────────────────────────────────────────

/**
 * Token bucket per host. docs/02_TRD.md §7 caps outbound traffic at 5 req/s per
 * host so a scan cannot become a denial-of-service against a target the user
 * nominated: an ethical requirement, not just a politeness one.
 */
export class HostRateLimiter {
  constructor(ratePerSecond = env.EGRESS_RPS_PER_HOST ?? 5) {
    this.rate = ratePerSecond;
    this.buckets = new Map();
  }

  /** Milliseconds to wait before a slot frees up. 0 when one is available now. */
  #delayFor(host, now) {
    const times = this.buckets.get(host) ?? [];
    const recent = times.filter((t) => now - t < 1000);
    this.buckets.set(host, recent);
    if (recent.length < this.rate) return 0;
    return 1000 - (now - recent[0]);
  }

  async acquire(host, { maxWaitMs = 5000, now = () => Date.now(), sleep = defaultSleep } = {}) {
    const start = now();
    for (;;) {
      const wait = this.#delayFor(host, now());
      if (wait <= 0) {
        this.buckets.get(host).push(now());
        return;
      }
      if (now() - start + wait > maxWaitMs) {
        throw new EgressError(
          EGRESS_ERROR.RATE_LIMITED,
          `Rate limit for ${host} exceeded (${this.rate} req/s).`,
          { host, rate: this.rate },
        );
      }
      await sleep(wait);
    }
  }

  reset() {
    this.buckets.clear();
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rateLimiter = new HostRateLimiter();

// ── Steps 4, 6, 7: the request itself ────────────────────────────────────────

/**
 * Performs ONE hop with the resolved IP pinned.
 *
 * Pinning is what defeats DNS rebinding (TOCTOU): without it, an attacker can
 * answer our validation lookup with a public IP and the connection lookup with
 * 169.254.169.254. Node's agent accepts a `lookup` override, so we hand it a
 * function that ignores DNS entirely and returns the address we already
 * validated. The Host header and TLS SNI still carry the original hostname, so
 * virtual hosting and certificate validation keep working.
 */
function requestOnce(url, { method, headers, body, pinnedIp, family, timeoutMs, maxBytes }) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { host: url.host, ...headers },
        servername: isHttps ? url.hostname : undefined,
        lookup: (_host, opts, cb) => {
          const fam = family === 6 ? 6 : 4;
          // TWO CALLING CONVENTIONS, and getting this wrong breaks every
          // request to a real hostname.
          //
          // Node >= 20 enables autoSelectFamily by default (Happy Eyeballs),
          // and that path calls a custom lookup with { all: true } and expects
          // an ARRAY of { address, family }. The older positional form
          // cb(null, address, family) is still used when autoSelectFamily is
          // off. Answering the array form positionally yields
          // "Invalid IP address: undefined", because Node reads addresses[0].
          //
          // This went unnoticed for several phases because every fixture is
          // reached at 127.0.0.1, and Node skips lookup entirely for an IP
          // literal, so the pinning path was never exercised by a test.
          // egress.test.js now covers it via a hostname.
          if (opts?.all) return cb(null, [{ address: pinnedIp, family: fam }]);
          return cb(null, pinnedIp, fam);
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        let truncated = false;

        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            // Stop reading rather than buffering an unbounded response.
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            bytes,
            truncated,
          });
        });

        res.on('close', () => {
          if (truncated) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
              bytes,
              truncated: true,
            });
          }
        });

        res.on('error', (err) =>
          reject(new EgressError(EGRESS_ERROR.NETWORK_ERROR, err.message, { cause: err.code })),
        );
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(
        new EgressError(EGRESS_ERROR.TIMEOUT, `Request to ${url.host} timed out after ${timeoutMs}ms`, {
          timeoutMs,
        }),
      );
    });

    req.on('error', (err) => {
      if (err instanceof EgressError) return reject(err);
      reject(new EgressError(EGRESS_ERROR.NETWORK_ERROR, err.message, { cause: err.code }));
    });

    if (body !== undefined && body !== null) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * The only sanctioned way to make an outbound request.
 *
 * @returns {Promise<{status, headers, body, bytes, truncated, url, ip, redirects, durationMs}>}
 */
export async function fetchGuarded(rawUrl, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = env.EGRESS_TIMEOUT_MS ?? 10_000,
    maxBytes = env.EGRESS_MAX_BYTES ?? 5_242_880,
    maxRedirects = 3,
    limiter = rateLimiter,
  } = options;

  const started = Date.now();
  let url = validateUrl(rawUrl);
  let currentMethod = method;
  let currentBody = body;
  const chain = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Re-validated on EVERY hop. A redirect to 169.254.169.254 is the classic
    // bypass of a guard that only checks the first URL.
    const { address, family } = await resolveAndValidate(url.hostname);
    await limiter.acquire(url.host, { maxWaitMs: timeoutMs });

    const res = await requestOnce(url, {
      method: currentMethod,
      headers,
      body: currentBody,
      pinnedIp: address,
      family,
      timeoutMs,
      maxBytes,
    });

    chain.push({ url: url.toString(), ip: address, status: res.status });

    const location = res.headers?.location;
    if (!REDIRECT_CODES.has(res.status) || !location) {
      return {
        ...res,
        url: url.toString(),
        ip: address,
        redirects: chain.slice(0, -1),
        durationMs: Date.now() - started,
      };
    }

    if (hop === maxRedirects) {
      throw new EgressError(
        EGRESS_ERROR.TOO_MANY_REDIRECTS,
        `Exceeded ${maxRedirects} redirects starting from ${rawUrl}`,
        { chain },
      );
    }

    // 303, and 301/302 on POST, become GET: matching browser behaviour.
    if (res.status === 303 || (currentMethod === 'POST' && res.status !== 307 && res.status !== 308)) {
      currentMethod = 'GET';
      currentBody = undefined;
    }

    url = validateUrl(new URL(location, url).toString());
  }

  /* c8 ignore next */
  throw new EgressError(EGRESS_ERROR.TOO_MANY_REDIRECTS, 'Redirect loop', { chain });
}

export default fetchGuarded;
