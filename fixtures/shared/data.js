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
