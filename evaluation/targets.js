/**
 * GROUND TRUTH for the security-detection measurement.
 *
 * docs/01_PRD.md F10 §1. Precision and recall are only meaningful against
 * labels fixed in advance, so this file is written from the fixtures' DEFECT
 * comments rather than from anything the scanner reported. If the scanner and
 * the labels ever agree because the labels were adjusted to match, the whole
 * measurement is circular, so treat this file as the specification and the
 * scanner as the thing under test.
 *
 * ── `intendedPublic` IS PART OF THE GROUND TRUTH ────────────────────────────
 * All but one of these endpoints are meant to be reachable anonymously. An
 * anonymous 200 there is CORRECT behaviour, not broken authentication. A
 * scanner with no such declaration reports an auth finding on every public
 * endpoint it ever sees. Encoding intent here is what makes the false-positive
 * number honest instead of flattering.
 *
 * ── THE AUTH FAMILY NEEDS CREDENTIALS ───────────────────────────────────────
 * `probe_auth` will not conclude "authentication is missing" from an anonymous
 * 200: it needs a real credential so it can send three requests (valid,
 * TAMPERED, anonymous) and compare. The tampered request is the discriminator:
 * a public endpoint ignores a forged token, whereas a broken one accepts it.
 *
 * Without a credential the probe correctly declines to draw a conclusion, so a
 * target that omits `headers` cannot be scored for auth at all. Leaving the
 * credential out would record a false negative against a scanner that behaved
 * exactly as designed.
 *
 * ── APP-LEVEL FAMILIES ──────────────────────────────────────────────────────
 * cors, headers and rate are properties of the whole application, so the
 * vulnerable app is genuinely defective in those families at EVERY endpoint,
 * and each endpoint contributes its own label. That is deliberate: a scan of
 * any single endpoint should surface them, and a scanner that only noticed them
 * on one arbitrary path would be worse.
 */

/** The token BOTH fixtures accept. The hardened app checks it; the vulnerable one does not. */
export const FIXTURE_ADMIN_TOKEN = 'fixture-admin-token';

/** Families in the order the report tabulates them. */
export const FAMILIES = ['sqli', 'xss', 'ssrf', 'redirect', 'auth', 'cors', 'headers', 'rate'];

/**
 * `vulnerable` lists the families that ARE genuinely present on that endpoint
 * of vulnerable-api. Everything not listed must produce no finding.
 * hardened-api is vulnerable in NOTHING, by construction: that is the app's
 * entire purpose, so it needs no per-endpoint labels.
 */
export const TARGETS = [
  {
    id: 'users-by-id',
    path: '/users/1',
    method: 'GET',
    description: 'Fetch a single user by numeric id. Returns id, username, email and role.',
    intendedPublic: true,
    // DEFECT 1: `SELECT * FROM users WHERE id = ${req.params.id}` plus a raw
    // driver error in the body, which is what makes the engine fingerprintable.
    vulnerable: ['sqli', 'cors', 'headers', 'rate'],
  },
  {
    id: 'items-filtered',
    path: '/items?ownerId=1',
    method: 'GET',
    description: 'List items, optionally filtered by ownerId. Returns an array of items.',
    intendedPublic: true,
    // DEFECT 1 again, on a query parameter: the more common shape.
    vulnerable: ['sqli', 'cors', 'headers', 'rate'],
  },
  {
    id: 'search-reflected',
    path: '/search?q=hello',
    method: 'GET',
    description: 'Search page. Echoes the q parameter back into an HTML response.',
    intendedPublic: true,
    // DEFECT 2: the term is written into the HTML unescaped.
    vulnerable: ['xss', 'cors', 'headers', 'rate'],
  },
  {
    id: 'fetch-preview',
    path: '/fetch?url=https://example.com/',
    method: 'GET',
    description: 'Link preview. Fetches the given url on the server and returns a summary.',
    intendedPublic: true,
    // DEFECT 7: fetches any url with no allow-list, cloud metadata included.
    vulnerable: ['ssrf', 'cors', 'headers', 'rate'],
  },
  {
    id: 'go-redirect',
    path: '/go?next=/home',
    method: 'GET',
    description: 'Post-action bounce. Redirects the browser to the next parameter.',
    intendedPublic: true,
    // DEFECT 8: redirects to any destination, on-site or not.
    vulnerable: ['redirect', 'cors', 'headers', 'rate'],
  },
  {
    id: 'admin-users',
    path: '/admin/users',
    method: 'GET',
    description: 'Privileged route listing every user. Requires a bearer token.',
    // NOT public. This is the one endpoint where an anonymous 200 is a finding.
    intendedPublic: false,
    // Supplied so probe_auth can strip and tamper with a REAL credential.
    headers: { authorization: `Bearer ${FIXTURE_ADMIN_TOKEN}` },
    // DEFECT 3: no authorisation check at all, and the password column leaks.
    vulnerable: ['auth', 'cors', 'headers', 'rate'],
  },
];

/** Endpoints used for the mutation study: the hardened app only. */
export const MUTATION_TARGETS = [
  {
    id: 'users-by-id',
    path: '/users/1',
    method: 'GET',
    description: 'Fetch a single user by numeric id. Returns id, username, email and role.',
  },
  {
    id: 'items',
    path: '/items',
    method: 'GET',
    description: 'List all items. Returns an array of objects with id, name, price and ownerId.',
  },
  {
    id: 'items-filtered',
    path: '/items?ownerId=1',
    method: 'GET',
    description: 'List items filtered by ownerId. Returns only items whose ownerId matches.',
  },
  {
    id: 'admin-users',
    path: '/admin/users',
    method: 'GET',
    description:
      'Privileged route listing every user. Requires an Authorization bearer token; ' +
      'anonymous requests must be rejected with 401.',
  },
];

/** Expected label for one (endpoint, family) pair. */
export const isVulnerable = (target, family, variant) =>
  variant === 'vulnerable' && target.vulnerable.includes(family);
