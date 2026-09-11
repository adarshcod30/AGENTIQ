# Evaluation fixtures

### Two Express apps with an identical contract. One is deliberately broken.

> ⚠️ **`vulnerable-api` is intentionally insecure. Never deploy it, never expose it.**
> It binds to `127.0.0.1` only.

These exist because **you cannot measure a security scanner without ground truth**
([docs/01_PRD.md](../docs/01_PRD.md) F10). A pass rate over a handful of GET requests against a
public API measures almost nothing; a labelled pair of apps measures precision and recall.

```bash
npm run fixtures        # starts both
```

| App | Port | Role in the measurement |
|---|---|---|
| `vulnerable-api` | **4001** | **Recall**: every defect here is one the agent should find |
| `hardened-api` | **4002** | **Precision**: the target is **zero findings** |

---

## Why the contract must be identical

Precision is measured as "findings on `hardened-api`" and recall as "findings on
`vulnerable-api`". That comparison only means something if the two apps differ **solely** in
their defects. If they differed in any other way, a finding on one and not the other could be
explained by that difference rather than by the vulnerability, and every number in the
evaluation would be uninterpretable.

So the identity is enforced, not assumed:

- `shared/data.js` holds the seed data, the ports, and the HTML page body. Both apps import it.
- The XSS route calls the *same* page builder; the only injected difference is the escape function.
- `tests/contract.test.js` sends every benign request to **both** apps and asserts the responses
  are equal. An accidental divergence fails the build.
- `shared/openapi.js` generates **both** specs from one builder, so they cannot drift either.

```bash
npm --workspace fixtures test     # 24 contract + defect tests
node fixtures/shared/openapi.js   # regenerate both specs
```

---

## The six defects

Each maps to one probe family in [docs/01_PRD.md](../docs/01_PRD.md) F3.

| # | Defect in `vulnerable-api` | Fix in `hardened-api` | Probe | OWASP |
|---|---|---|---|---|
| 1 | `SELECT * FROM users WHERE id = ${id}`: concatenated, and the driver error is returned in the body | Parameterised statement; generic error, no engine detail | `probe_sqli` | API8:2023 |
| 2 | `?q=` echoed unescaped into the HTML response | HTML-escaped output | `probe_xss` | API8:2023 |
| 3 | `/admin/users` returns every user *including the password column*, anonymously | Bearer token required; passwords never serialised | `probe_auth` | API2:2023 |
| 4 | `Access-Control-Allow-Origin: *` **with** `Allow-Credentials: true` | Explicit origin allow-list, `Vary: Origin` | `probe_cors` | API8:2023 |
| 5 | No HSTS, CSP, X-Content-Type-Options or X-Frame-Options; `X-Powered-By` left on | `helmet`, `X-Powered-By` disabled | `probe_headers` | API8:2023 |
| 6 | No rate limiting | `express-rate-limit`, 60/min | rate-limit probe | API4:2023 |

Defects 1 and 3 are reachable through *two* shapes each: a path parameter and a query
parameter for the injection, so a probe that only tests one location is still detectable as
incomplete.

---

## Routes (both apps)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | `{ status, variant }`: `variant` is the only intended difference |
| `GET` | `/users/{id}` | Public projection; never includes `password` |
| `GET` | `/items?ownerId=` | Optional filter |
| `GET` | `/search?q=` | Returns HTML: the XSS surface |
| `GET` | `/admin/users` | Privileged; `bearerAuth` in the spec |
| `POST` | `/login` | `{ username, password }` → `{ token, user }` |

Seed data: 3 users (`alice`, `bob`, `carol`: carol is `admin`), 3 items.
Admin token: `fixture-admin-token`.

---

## Notes

**SQLite comes from `node:sqlite`**, built into Node 22, so the fixtures add no native
dependency and nothing to compile. It prints an experimental-feature warning on start, which is
expected and harmless.

**Passwords are stored in plaintext in the seed data on purpose.** These are throwaway records
in a deliberately-broken test app. The point of defect 3 is that the vulnerable app *leaks* that
column; storing a bcrypt hash would obscure the very thing being measured.

**Scanning these is safe and authorised**: you own them, they are local-only, and that is
exactly the situation the security agent's host-acknowledgement flow exists for. To scan them
from AGENTIQ you must set `ALLOW_PRIVATE_TARGETS=true`, because the SSRF egress guard blocks
loopback by default ([docs/02_TRD.md](../docs/02_TRD.md) §7). That flag is refused outright when
`NODE_ENV=production`.
