/**
 * vulnerable-api: DELIBERATELY DEFECTIVE. Never deploy this.
 *
 * docs/01_PRD.md F10. This is the ground truth for measuring the security
 * agent's RECALL: every defect below is one the agent is expected to find.
 * Its twin, hardened-api, serves identical routes with identical response
 * shapes and every defect fixed, and measures FALSE POSITIVES.
 *
 * The defects, each mapped to the probe family that should catch it:
 *
 *   1. SQL injection      string-concatenated query, DB errors leaked in the body
 *   2. Reflected XSS      query parameter echoed unescaped into HTML
 *   3. Broken auth        /admin/users returns data with no auth check
 *   4. CORS               Access-Control-Allow-Origin: * WITH credentials
 *   5. Security headers: none set at all
 *   6. Rate limiting      none
 *
 * Bound to 127.0.0.1 only. It must never be reachable off this machine.
 */
import express from 'express';
import {
  PORTS, ADMIN_TOKEN, publicUser, createDb, searchPage, noEscape,
} from '../shared/data.js';

const db = await createDb();
export const app = express();

app.use(express.json());

// ── DEFECT 4: permissive CORS with credentials ──────────────────────────────
// ACAO:* combined with Allow-Credentials is the classic misconfiguration: it
// tells a browser that any origin may read authenticated responses.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// ── DEFECT 5: no security headers ───────────────────────────────────────────
// No helmet, no HSTS, no CSP, no X-Content-Type-Options, no X-Frame-Options.
// Express's own X-Powered-By is left ON, which also leaks the stack.

// ── DEFECT 6: no rate limiting ──────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', variant: 'vulnerable' }));

/**
 * DEFECT 1: SQL injection.
 * The id is concatenated straight into the statement, and the raw driver error
 * is returned in the body, which is what makes the database fingerprintable.
 */
app.get('/users/:id', (req, res) => {
  const sql = `SELECT * FROM users WHERE id = ${req.params.id}`;
  try {
    const row = db.prepare(sql).get();
    if (!row) return res.status(404).json({ error: 'User not found' });
    return res.json(publicUser(row));
  } catch (err) {
    // Leaking the driver message is the signal probe_sqli fingerprints on.
    return res.status(500).json({ error: 'SQLITE_ERROR: ' + err.message, sql });
  }
});

/** Same injection on a query parameter, which is the more common shape. */
app.get('/items', (req, res) => {
  const { ownerId } = req.query;
  const sql = ownerId
    ? `SELECT * FROM items WHERE ownerId = ${ownerId}`
    : 'SELECT * FROM items';
  try {
    return res.json(db.prepare(sql).all());
  } catch (err) {
    return res.status(500).json({ error: 'SQLITE_ERROR: ' + err.message, sql });
  }
});

/**
 * DEFECT 2: reflected XSS.
 * The search term is written into the HTML response without escaping.
 */
app.get('/search', (req, res) => {
  res.type('html').send(searchPage(req.query.q ?? '', noEscape));
});

/**
 * DEFECT 3: broken authentication.
 * A privileged route that returns every user, including the password column,
 * with no authorisation check whatsoever.
 */
app.get('/admin/users', (req, res) => {
  const rows = db.prepare('SELECT * FROM users').all();
  return res.json({ users: rows }); // includes `password`
});

app.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || row.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  return res.json({ token: ADMIN_TOKEN, user: publicUser(row) });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORTS.vulnerable, '127.0.0.1', () => {
    process.stdout.write(
      `vulnerable-api  http://127.0.0.1:${PORTS.vulnerable}  (DELIBERATELY INSECURE)\n`,
    );
  });
}

export default app;
