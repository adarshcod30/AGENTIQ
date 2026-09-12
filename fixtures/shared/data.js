/**
 * Seed data and the response contract, shared by BOTH fixtures.
 *
 * docs/01_PRD.md F10 requires the two apps to have identical routes and
 * identical response contracts, differing ONLY in their defects. If they differ
 * in any other way, a finding on one and not the other could be explained by
 * the difference rather than by the vulnerability, and the whole precision /
 * recall measurement becomes uninterpretable.
 *
 * Sharing the data and the shapes here is what makes that guarantee structural
 * rather than a matter of keeping two files in sync by hand.
 */

export const PORTS = {
  vulnerable: 4001,
  hardened: 4002,
};

/** Seeded users. `password` is stored plainly in the fixture on purpose,
 *  these are throwaway records in a deliberately-broken test app, never real. */
export const USERS = [
  { id: 1, username: 'alice', email: 'alice@example.com', role: 'user', password: 'alice-pw' },
  { id: 2, username: 'bob', email: 'bob@example.com', role: 'user', password: 'bob-pw' },
  { id: 3, username: 'carol', email: 'carol@example.com', role: 'admin', password: 'carol-pw' },
];

export const ITEMS = [
  { id: 1, name: 'Widget', price: 9.99, ownerId: 1 },
  { id: 2, name: 'Gadget', price: 24.5, ownerId: 2 },
  { id: 3, name: 'Doohickey', price: 3.25, ownerId: 3 },
];

/** The admin token both apps accept. The hardened app CHECKS it; the vulnerable one does not. */
export const ADMIN_TOKEN = 'fixture-admin-token';

/** Creates and seeds an in-memory SQLite database. node:sqlite ships with Node 22,
 *  no native dependency, so the fixtures install nothing. */
export function createDb() {
  // Imported lazily so the module can be read without the sqlite flag warning.
  // eslint-disable-next-line no-undef
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT, email TEXT, role TEXT, password TEXT
      );
      CREATE TABLE items (
        id INTEGER PRIMARY KEY, name TEXT, price REAL, ownerId INTEGER
      );
    `);
    const u = db.prepare('INSERT INTO users VALUES (?,?,?,?,?)');
    for (const x of USERS) u.run(x.id, x.username, x.email, x.role, x.password);
    const i = db.prepare('INSERT INTO items VALUES (?,?,?,?)');
    for (const x of ITEMS) i.run(x.id, x.name, x.price, x.ownerId);
    return db;
  });
}

/** Public projection, never includes the password column. */
export const publicUser = (row) => ({
  id: row.id, username: row.username, email: row.email, role: row.role,
});

/**
 * The HTML page used by the reflected-XSS route.
 *
 * Both apps render the SAME page for the SAME input; only the escaping differs.
 * `escape` is the injected difference and the ONLY difference.
 */
export const searchPage = (term, escape) => `<!doctype html>
<html><head><title>Search</title></head>
<body><h1>Results</h1><p>You searched for: ${escape(term)}</p>
<ul></ul></body></html>`;

export const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** No escaping at all: the vulnerable app's defect. */
export const noEscape = (s) => String(s);

// ── URL-fetch and redirect helpers (defects 7 and 8) ─────────────────────────

/**
 * True for a host a server must never fetch on a client's behalf: loopback,
 * private ranges, link-local (which includes the cloud metadata address) and
 * the internal DNS names. The hardened /fetch checks this; the vulnerable one
 * does not. Only what the fixtures exercise, not a full parser.
 */
export function isPrivateUrlHost(host) {
  const h = String(host ?? '').split(':')[0].toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1') return true;
  if (h === 'metadata.google.internal' || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/** Stand-in for content a real SSRF against the cloud metadata service returns. */
export const metadataBody = () => JSON.stringify({
  Code: 'Success',
  Type: 'AWS-HMAC',
  AccessKeyId: 'ASIAFIXTUREEXAMPLE',
  SecretAccessKey: 'wFixtureSecretKeyDoNotUse',
  Token: 'FIXTURE-SESSION-TOKEN',
});

/** The identical, network-free preview both apps return for an allowed URL. */
export const previewOf = (url) => ({
  url, ok: true, status: 200, contentType: 'text/html', title: 'Fixture preview',
});

/**
 * A redirect target that stays on this site: exactly "/" or a path beginning
 * with a single "/" that is not "//" or "/\" (both of which a browser reads as
 * protocol-relative and would leave the site). The hardened /go enforces this.
 */
export function isSafeRelativePath(next) {
  const v = String(next ?? '');
  if (v === '/') return true;
  return /^\/[^/\\]/.test(v);
}
