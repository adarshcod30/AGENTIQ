/**
 * Detectors for SSRF (API7:2023) and open redirect.
 *
 * Both defects live in the same place: a parameter that a server treats as a
 * URL. SSRF is the server FETCHING that URL; open redirect is the server
 * SENDING THE BROWSER to it. So the two probes share their idea of "which
 * parameters look like they take a URL", and differ only in what they do next.
 *
 * The hard part of both is precision. An endpoint that simply echoes a query
 * value back is not vulnerable to either, and a detector that fires on a
 * reflected string would flag half the internet. Every signal below is tied to
 * evidence that could only come from the defect: metadata content, a
 * server-side network error naming the host we injected, or an off-site
 * Location header carrying our unique canary.
 */
import { bodyToText } from './fingerprints.js';

// ── Parameters that tend to carry a URL ──────────────────────────────────────

/** Names a server-side fetcher tends to read a URL from. */
export const SSRF_PARAM_NAMES = new Set([
  'url', 'uri', 'link', 'src', 'source', 'target', 'dest', 'destination',
  'callback', 'webhook', 'feed', 'host', 'domain', 'site', 'page', 'path',
  'image', 'imageurl', 'img', 'avatar', 'fetch', 'load', 'proxy', 'remote',
  'upstream', 'endpoint', 'resource', 'file', 'document', 'data', 'reference',
]);

/** Names an open-redirect sink tends to read a destination from. */
export const REDIRECT_PARAM_NAMES = new Set([
  'redirect', 'redirect_uri', 'redirect_url', 'redirecturl', 'redir', 'url',
  'next', 'return', 'returnto', 'return_to', 'returnurl', 'return_url',
  'dest', 'destination', 'continue', 'goto', 'go', 'to', 'out', 'target',
  'forward', 'callback', 'checkout_url', 'success_url', 'u', 'r',
]);

/** A value that already looks like a URL or a bare host: worth probing too. */
export function looksLikeUrlValue(value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  return /^https?:\/\//i.test(v) || /^\/\//.test(v) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v);
}

/**
 * The parameters worth injecting into, in priority order.
 *
 * A param already present whose NAME matches wins first, then a param whose
 * VALUE already looks like a URL, then, if neither exists, the caller's
 * fallback names so an endpoint that reads an undeclared `?url=` is still
 * reachable. Deduped, and capped so one scan cannot fan out unboundedly.
 */
export function urlParamTargets(rawUrl, { names, fallback, limit = 4 }) {
  const url = new URL(rawUrl);
  const present = [...url.searchParams.keys()];
  const picked = [];

  for (const key of present) {
    if (names.has(key.toLowerCase())) picked.push(key);
  }
  for (const key of present) {
    if (!picked.includes(key) && looksLikeUrlValue(url.searchParams.get(key))) picked.push(key);
  }
  if (picked.length === 0) picked.push(...fallback);

  return [...new Set(picked)].slice(0, limit);
}

/** Sets one query parameter to `value`, returning the full URL string. */
export function withParam(rawUrl, key, value) {
  const url = new URL(rawUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

// ── SSRF signals ─────────────────────────────────────────────────────────────

/**
 * Payloads that point at places a server should never reach on a client's
 * behalf. The link-local metadata address is the one that matters most: on a
 * cloud host it hands out the instance's IAM credentials.
 */
export const SSRF_CANARIES = [
  {
    value: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    label: 'AWS instance metadata',
    kind: 'metadata',
  },
  {
    value: 'http://metadata.google.internal/computeMetadata/v1/',
    label: 'GCP metadata',
    kind: 'metadata',
  },
  {
    // An address nothing should answer on: a server that TRIES proves the
    // parameter feeds a real request, even when this particular target refuses.
    value: 'http://127.0.0.1:9/',
    label: 'loopback discard port',
    kind: 'private',
  },
];

/**
 * Content that could only have come from a cloud metadata service, chosen so it
 * cannot appear in the canary URL we sent: an endpoint that merely reflects the
 * injected value back must not trip this. That rules out path fragments like
 * "iam/security-credentials" or "computeMetadata", which live in the request
 * URL, and keeps only strings from the credential RESPONSE body.
 */
export const METADATA_MARKERS =
  /\bAccessKeyId\b|\bSecretAccessKey\b|\bInstanceProfileArn\b|"Code"\s*:\s*"Success"/i;

/**
 * A server-side network error, naming what failed to connect. Deliberately
 * narrow: real socket errors, not the word "failed" in ordinary prose. Seeing
 * one of these next to the host WE injected is proof the parameter is used to
 * open a connection, which is the SSRF surface.
 */
export const SSRF_NETWORK_ERROR =
  /\b(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN|getaddrinfo|socket hang up|fetch failed|request to .* failed)\b/i;

/** The host portion of a canary, for matching an echo in the response. */
export function hostOfCanary(canaryValue) {
  try { return new URL(canaryValue).host; } catch { return null; }
}

/**
 * Reads an SSRF verdict out of the response to an injected canary.
 *
 * @returns {{ vulnerable: boolean, severity: string|null, signal: string|null, kind: string|null }}
 */
export function detectSsrf(body, canary) {
  const text = bodyToText(body);
  if (!text) return { vulnerable: false, severity: null, signal: null, kind: null };

  const meta = text.match(METADATA_MARKERS);
  if (meta) {
    const at = meta.index ?? 0;
    return {
      vulnerable: true,
      severity: 'critical',
      kind: 'metadata',
      signal:
        `The response carried internal metadata content ("${text.slice(Math.max(0, at - 20), at + 60).trim()}") ` +
        `after the parameter was pointed at ${canary.label}.`,
    };
  }

  // The host we injected, echoed next to a genuine socket error. This proves the
  // value is used to make a server-side request, even if the target refused.
  const host = hostOfCanary(canary.value);
  const hostEchoed = host && text.includes(host.split(':')[0]);
  const netErr = text.match(SSRF_NETWORK_ERROR);
  if (hostEchoed && netErr) {
    const at = netErr.index ?? 0;
    return {
      vulnerable: true,
      severity: 'high',
      kind: 'network',
      signal:
        `The server tried to reach ${host} on its own side and reported ` +
        `"${text.slice(Math.max(0, at - 20), at + 60).trim()}". The parameter feeds a server-side request.`,
    };
  }

  return { vulnerable: false, severity: null, signal: null, kind: null };
}

// ── Open-redirect signals ────────────────────────────────────────────────────

/**
 * A host the target cannot have on an allow-list on purpose. Unique enough that
 * a Location carrying it can only have come from OUR injected value.
 */
export const REDIRECT_CANARY_HOST = 'agentiq-redirect-probe.example';

/** Builds the canary destination, marked so a match is attributable to us. */
export function redirectCanary(nonce) {
  return `https://${REDIRECT_CANARY_HOST}/agentiq-open-redirect-${nonce}`;
}

/**
 * Decides whether a redirect response sends the browser off-site to our canary.
 *
 * `location` is resolved against the request URL, so a relative Location (the
 * safe, same-site case) resolves back to the target's own host and does NOT
 * fire. Only an absolute jump to the canary host counts.
 */
export function isOpenRedirect({ status, location, requestUrl }) {
  if (!(status >= 300 && status < 400) || !location) return { vulnerable: false, to: null };
  let resolved;
  try {
    resolved = new URL(location, requestUrl);
  } catch {
    return { vulnerable: false, to: null };
  }
  const vulnerable = resolved.host.toLowerCase() === REDIRECT_CANARY_HOST;
  return { vulnerable, to: resolved.toString() };
}
