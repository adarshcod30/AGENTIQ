/**
 * hardened-api: the SAME contract, every defect fixed.
 *
 * docs/01_PRD.md F10. This app measures FALSE POSITIVES: the acceptance
 * criterion is **zero findings** here. Any finding the security agent reports
 * against this app is, by construction, wrong.
 *
 * That only holds if the two apps are genuinely identical apart from their
 * defects: same routes, same status codes, same response shapes. The shared
 * test suite (fixtures/tests/contract.test.js) asserts exactly that, so a
 * divergence introduced by accident fails the build rather than quietly
 * invalidating the evaluation.
 *
 * The fixes, paired with the vulnerable app's defects:
 *
 *   1. SQL injection    -> parameterised statements, generic error bodies
 *   2. Reflected XSS    -> HTML-escaped output
 *   3. Broken auth      -> bearer token required on /admin/users
 *   4. CORS             -> explicit origin allow-list, no wildcard+credentials
 *   5. Security headers -> helmet
 *   6. Rate limiting    -> express-rate-limit
 *   7. SSRF             -> /fetch refuses private and internal hosts, no fetch
 *   8. Open redirect    -> /go only bounces to same-site paths
 */
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  PORTS, ADMIN_TOKEN, publicUser, createDb, searchPage, escapeHtml,
  isPrivateUrlHost, previewOf, isSafeRelativePath,
} from '../shared/data.js';

const db = await createDb();
export const app = express();

app.use(express.json());
app.disable('x-powered-by');

// ── FIX 5: security headers ─────────────────────────────────────────────────
app.use(helmet({
  // The fixture is served over plain http on loopback, so HSTS would be
  // meaningless in a browser, but the header is what probe_headers checks for,
  // and its absence is a real finding, so it is set explicitly.
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
}));

// ── FIX 4: strict CORS ──────────────────────────────────────────────────────
// A concrete origin, echoed only when it matches. Never `*` with credentials,
// the two are mutually exclusive in any correct configuration.
const ALLOWED_ORIGINS = new Set(['http://localhost:5173']);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  next();
});

// ── FIX 6: rate limiting ────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

app.get('/health', (req, res) => res.json({ status: 'ok', variant: 'hardened' }));

/** FIX 1: parameterised query, and no driver detail in the error body. */
app.get('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  return res.json(publicUser(row));
});

app.get('/items', (req, res) => {
  const { ownerId } = req.query;
  if (ownerId === undefined) return res.json(db.prepare('SELECT * FROM items').all());
  const owner = Number(ownerId);
  if (!Number.isInteger(owner)) return res.status(400).json({ error: 'Invalid ownerId' });
  return res.json(db.prepare('SELECT * FROM items WHERE ownerId = ?').all(owner));
});

/** FIX 2: the same page, escaped. */
app.get('/search', (req, res) => {
  res.type('html').send(searchPage(req.query.q ?? '', escapeHtml));
});

/** FIX 3: authorisation required, and the password column never leaves. */
app.get('/admin/users', (req, res) => {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const rows = db.prepare('SELECT * FROM users').all();
  return res.json({ users: rows.map(publicUser) });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || row.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  return res.json({ token: ADMIN_TOKEN, user: publicUser(row) });
});

/** FIX 7: refuse private and internal hosts up front, and never fetch them. */
app.get('/fetch', (req, res) => {
  const raw = String(req.query.url ?? '');
  let host;
  try { host = new URL(raw).host; } catch { return res.status(400).json({ error: 'Invalid url' }); }
  if (isPrivateUrlHost(host)) return res.status(400).json({ error: 'URL host not allowed' });
  return res.json(previewOf(raw));
});

/** FIX 8: only ever bounce to a same-site path; anything off-site falls back to "/". */
app.get('/go', (req, res) => {
  const next = String(req.query.next || '/');
  return res.redirect(isSafeRelativePath(next) ? next : '/');
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(PORTS.hardened, '127.0.0.1', () => {
    process.stdout.write(`hardened-api    http://127.0.0.1:${PORTS.hardened}\n`);
  });
}

export default app;
