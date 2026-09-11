# 02 · Technical design

### Architecture, the exact stack, and the constraints behind it

> Companion to [01_PRD.md](01_PRD.md). That document is *what*; this one is *how*.

---

## 1. The shape of it

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER: React 19 SPA (Vite 8, Tailwind 4)                              │
│  Dashboard · Test Runner · Security · Specs · API Client · History       │
│  Deploy · Tool Registry · Audit Log · Settings · About                   │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTPS + Bearer JWT
┌───────────────────────────────▼──────────────────────────────────────────┐
│  API SERVER: Express 5 (Node 22)                                         │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Routes    /api/auth /runs /security /specs /request /deployments   │  │
│  │           /mcp /health                                             │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ Services  run · deployment · spec · stats · llm · verification     │  │
│  │           (run.service sequences the agents and persists TestRun)  │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ AGENTS    testing.agent · security.agent · deployment.agent        │  │
│  │           (agents hold NO I/O: they only call tools)               │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ ██ MCP LAYER ██  registry · Zod schemas · permission gate · audit  │  │
│  │    http_request  run_test_case  probe_sqli  probe_xss  probe_auth  │  │
│  │    probe_cors    probe_headers  parse_openapi  deploy_service      │  │
│  ├────────────────────────────────────────────────────────────────────┤  │
│  │ Egress guard: SSRF filter · IP pinning · rate limit · timeout · cap│  │
│  └────────────────────────────────────────────────────────────────────┘  │
└────────┬──────────────────────┬──────────────────────┬──────────────────┘
         │                      │                      │
   ┌─────▼─────┐        ┌───────▼────────┐     ┌───────▼────────┐
   │ MongoDB   │        │ LLM providers  │     │ Target APIs    │
   │ Atlas     │        │ Bedrock (Nova) │     │ user-nominated │
   │ users,    │        │  → Groq        │     │ Render API     │
   │ runs,     │        └────────────────┘     │ GitHub API     │
   │ specs,    │                               └────────────────┘
   │ audit,    │
   │ deploys   │
   └───────────┘
```

**The one architectural rule that matters:** an agent may not perform I/O. It may only call an
MCP tool. If `axios` were ever imported inside `security.agent.js`, the MCP claim would be false.
This is enforced mechanically by `server/tests/architecture.test.js` (§11).

---

## 2. Stack

Versions are pinned. Install with **`npm ci`**, which reads the committed lockfile.

> **Regenerating the lockfile needs npm 11.** npm 10.9 crashes (`Cannot read properties of null
> (reading 'edgesOut')`) when it resolves this workspace graph from scratch, a known arborist bug.
> Installing *from* the lockfile works on npm 10, which is what CI does.

### Runtime

| | Version | Why |
|---|---|---|
| **Node.js** | **22.x LTS** (at least 22.12.0) | Vite 8 requires `^20.19 \|\| >=22.12`; Mongoose 9 requires at least 20.19. Pinned in `.nvmrc` and `engines`. |
| **Package manager** | npm, workspaces | One workspace root with `server`, `web` and `fixtures`. |

### Backend

| Package | Version | Notes |
|---|---|---|
| `express` | `5.2.1` | **v5**: async errors auto-forward; `req.query` is a getter |
| `mongoose` | `9.9.2` | requires Node 20.19 or later |
| `@modelcontextprotocol/sdk` | `1.30.0` | `McpServer`, `registerTool`, streamable-HTTP and stdio transports |
| `zod` | `4.4.3` | **v4**: the source of truth for every tool schema |
| `@aws-sdk/client-bedrock-runtime` | `^3.1111.0` | Bedrock Converse API, the primary LLM provider |
| `axios` | `1.19.0` | used only by `services/llm.js` for Groq, never by an agent |
| `jsonwebtoken` | `9.0.3` | |
| `bcryptjs` | `3.0.3` | pure JS, so no native build step on any platform |
| `passport` / `passport-google-oauth20` | `0.7.0` / `2.0.0` | registered lazily (§8) |
| `nodemailer` | `^9.1.1` | verification mail over Gmail SMTP or any SMTP URL |
| `cors` / `cookie-parser` | `2.8.6` / `1.4.7` | |
| `helmet` | `8.3.0` | security headers on the API itself |
| `express-rate-limit` | `8.6.2` | auth endpoints |
| `pino` / `pino-http` | `10.3.1` / `11.0.0` | structured logs with secret redaction |
| `@apidevtools/swagger-parser` | `12.1.0` | OpenAPI 3.x parse and `$ref` dereference |
| `js-yaml` | `4.3.2` | YAML specs |
| `dotenv` | `17.4.2` | |

Dev: `vitest@4.1.11`, `@vitest/coverage-v8@4.1.11`, `supertest@7.2.2`,
`mongodb-memory-server@11.2.0`, `nodemon@3.1.14`, `eslint@9.39.5`.

### Frontend

| Package | Version | Notes |
|---|---|---|
| `react` / `react-dom` | `19.2.8` | |
| `vite` | `8.2.1` | |
| `@vitejs/plugin-react` | `6.0.5` | its `@rolldown/plugin-babel` and `babel-plugin-react-compiler` peers are optional and not installed |
| `typescript` | `7.0.2` | the native port |
| `tailwindcss` + `@tailwindcss/vite` | `4.3.3` | **v4, CSS-first config.** See §3 |
| `react-router-dom` | `7.18.2` | v7 |
| `@tanstack/react-query` | `5.101.4` | server state |
| `zustand` | `5.0.15` | client state (auth) |
| `recharts` | `3.10.1` | **v3** |
| `lucide-react` | `1.31.0` | **v1** |
| `@fontsource/inter`, `@fontsource/jetbrains-mono` | `5.3.0` | self-hosted fonts, so no CDN is needed at runtime |
| `axios` | `1.19.0` | |
| `clsx` | `2.1.1` | |

Dev: `@types/react@19.2.18`, `@types/react-dom@19.2.4`.

---

## 3. Major-version notes

Several packages above are on recent major versions. Snippets written for the previous majors
(React 18, Vite 5, Tailwind 3, Zod 3, React Router 6, Recharts 2) will not work unchanged.

**Tailwind v4, the big one.** There is no `tailwind.config.js` and no `postcss.config.js`.
- Vite plugin: `import tailwindcss from '@tailwindcss/vite'` in `vite.config.ts`.
- The CSS entry is `@import "tailwindcss";`, **not** `@tailwind base/components/utilities`.
- Design tokens live in CSS: `@theme { --color-primary: #1B4D89; ... }`, which generates
  `bg-primary`, `text-primary` and so on automatically.
- `@layer components` still works for `.btn` and `.card` shorthands.
- Any snippet using `@tailwind base` or a JS config is v3 and needs rewriting.

**Express 5.**
- Rejected promises in handlers auto-forward to the error middleware, so there is no manual
  `try/catch` then `next(err)` boilerplate.
- `req.query` is a getter; you cannot assign to it.
- Wildcards need names: `app.use('/*splat', handler)`, not `app.use('*', handler)`.

**Zod 4.**
- `z.string().email()` becomes `z.email()`; the same for `url()` and `uuid()`.
- Error customisation: `{ message }` becomes `{ error }`.
- `.strict()` semantics changed; read the migration note before relying on it.

**React Router 7.** The package is still `react-router-dom`; v6 data-router APIs carry over.
`createBrowserRouter` is used throughout.

**React 19.** `forwardRef` is no longer needed, because `ref` is a normal prop. `useFormState` is
now `useActionState`. Strict Mode double-invokes effects in development; that is expected.

**Recharts 3.** `ResponsiveContainer` sizing changed, and some `Tooltip` and `Legend` props were
renamed. Verify each chart visually rather than trusting v2 code.

**Mongoose 9.** The `strictQuery` default changed, and callback signatures are gone (promises
only).

---

## 4. Repository layout

```
AGENTIQ/
├── README.md
├── LICENSE
├── Dockerfile                  ← API image (non-root, exec-form CMD)
├── .nvmrc                      ← 22
├── .gitattributes              ← * text=auto eol=lf
├── .env.example                ← every variable, no values
├── package.json                ← workspace root: dev, test, lint, evaluate scripts
├── .github/workflows/
│   ├── ci.yml                  ← install, lint, typecheck, test, coverage gate, audit
│   └── keep-warm.yml           ← scheduled /api/health ping
├── docs/
│   ├── 01_PRD.md  02_TRD.md  03_App_Flow.md  04_App_UI.md  05_AWS_ARCHITECTURE.md
│   ├── 06_SETUP.md  06_SETUP_AUTH.md  07_DEPLOYMENT_CHECKLIST.md  08_COLLABORATOR_SETUP.md
│   └── 90_EVALUATION.md        ← generated by the harness, never hand-edited
├── server/
│   ├── src/
│   │   ├── index.js            ← boot only: config check, then app, then listen
│   │   ├── app.js              ← the Express app, no listen (so tests can import it)
│   │   ├── config/             ← env.js (validated with Zod, fail fast) · passport.js
│   │   ├── mcp/
│   │   │   ├── registry.js     ← tool registration and withGuards, the single source of truth
│   │   │   ├── permissions.js  ← risk classes and grant checks
│   │   │   ├── audit.js        ← writes one record per invocation
│   │   │   ├── egress.js       ← SSRF guard, IP pinning, rate limit, timeout, size cap
│   │   │   ├── ipRules.js      ← blocked address ranges, IPv4 and IPv6
│   │   │   ├── transport.js    ← streamable-HTTP MCP endpoint
│   │   │   ├── stdio.js        ← stdio MCP entrypoint for local clients
│   │   │   ├── probes/         ← baseline differential · database error fingerprints
│   │   │   └── tools/          ← one file per tool, plus the shared probe schema
│   │   ├── agents/             ← testing · security · deployment   (NO I/O HERE)
│   │   ├── services/           ← run · deployment · spec · stats · llm · explain
│   │   │                          jsonRepair · verification · mailer
│   │   ├── models/             ← User · TestRun · ApiSpec · AuditEvent · Deployment
│   │   │                          EmailVerification
│   │   ├── routes/  controllers/  middleware/  lib/  utils/
│   ├── scripts/migrate-users.js
│   └── tests/                  ← vitest + supertest + mongodb-memory-server
├── web/
│   ├── src/
│   │   ├── main.tsx  routes.tsx  index.css   ← Tailwind v4 @theme lives here
│   │   ├── components/{ui,layout}/  pages/  hooks/  services/  store/  types/  lib/
│   ├── public/brand/            ← generated logo set
│   └── vite.config.ts
├── fixtures/
│   ├── vulnerable-api/          ← deliberately broken (evaluation target)
│   ├── hardened-api/            ← the same contract, defects fixed
│   ├── shared/                  ← seed data, response contract, OpenAPI builder
│   └── tests/contract.test.js   ← asserts the two apps are identical apart from defects
├── evaluation/
│   ├── run.js                   ← npm run evaluate
│   ├── security.eval.js  mutation.eval.js  mutants.js  targets.js  lib.js  report.js
│   └── results/latest.json      ← raw observations behind docs/90_EVALUATION.md
└── scripts/generate-logo.py     ← rebuilds web/public/brand/
```

---

## 5. The MCP layer

### 5.1 Registration

One file owns the registry. Tools are registered with `registerTool` (not the deprecated
`tool`). Simplified:

```js
// server/src/mcp/registry.js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const mcp = new McpServer(
  { name: 'agentiq', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

export const TOOLS = [];   // mirror used by /api/mcp/tools and the permission gate

export function defineTool({ name, title, description, riskClass, inputSchema, outputSchema, handler }) {
  const guarded = withGuards({ name, riskClass, inputSchema, handler });
  TOOLS.push({ name, title, description, riskClass, inputSchema, outputSchema, handler: guarded });
  mcp.registerTool(name, { title, description, inputSchema, outputSchema }, guarded);
}
```

`withGuards` is the whole architecture in one wrapper, and the order is not negotiable:

```
1. permission check        ← a denied call never reaches validation or the network
2. schema validation       ← BEFORE any I/O; a malformed input is rejected here
3. handler                 ← reaches the network only through the egress guard
finally: ONE audit record  ← ok | denied | error | blocked_ssrf | rate_limited, even on throw
```

Writing exactly one record in `finally` is what makes "audit count equals tool-call count" true.

HTTP sessions each get their own `McpServer` from `createMcpServer()`, because the SDK binds a
server to one transport. The module singleton serves stdio, where the process has one client.

### 5.2 Risk classes

| Class | Meaning | Default |
|---|---|---|
| `local.compute` | No network. Parsing, evaluation. | auto-granted |
| `network.read` | Benign request to a user-nominated host | granted per host |
| `network.probe` | Attack-indicator payloads to a user-nominated host | **explicit grant, per host, per session** |
| `deploy.write` | Mutates external infrastructure | explicit grant plus confirmation |

Grants are held per session and echoed in every audit record. **`network.probe` is never
auto-granted.** Firing SQL injection payloads at a host the user did not knowingly nominate is
the one mistake here that would be genuinely serious.

### 5.3 Audit record

```js
{ _id, userId, sessionId, runId, tool, riskClass, targetHost,
  inputHash,            // SHA-256 of the canonicalised input; raw payloads are never stored
  outcome,              // 'ok' | 'denied' | 'error' | 'blocked_ssrf' | 'rate_limited'
  errorCode, reason, durationMs, ts }
```

Immutable: no update or delete path exists in the API, and the schema refuses updates at the
mongoose layer too.

### 5.4 Transport

The MCP server is exposed over **streamable HTTP** at `/api/mcp`, behind auth, so an external MCP
client (Claude Desktop, an IDE) can drive AGENTIQ's tools directly. A **stdio** entrypoint,
`server/src/mcp/stdio.js`, serves local clients. Either way, every call goes through the same
`withGuards` chain: exposing the tools over HTTP opens no side channel around the controls.

*AGENTIQ is not just built on MCP; it is itself an MCP server other agents can use.*

---

## 6. Agents

Thin orchestration over tools. No I/O.

**Testing agent.** Builds the prompt (spec-grounded when a spec is attached), calls the LLM in
JSON mode, validates against Zod with one bounded repair retry, then calls `run_test_case` for
each case and collects per-assertion results. Returns `{ summary, functional, generation }`, where
`generation` records provider, model, tokens, cost, attempts and generation time.

**Security agent.** For each enabled family, calls its `probe_*` tool. Each probe sends its own
benign baseline and its payloads, then classifies the response against that baseline. The rate
family is orchestrated here from repeated `http_request` calls. Returns findings with severity,
OWASP category, payload, signal, baseline, explanation and remediation, plus a summary with a
disclaimer that a clean scan is not a guarantee.

**Deployment agent.** Runs read-only preflight checks against the GitHub API, then the
`deploy_service` actions against Render, polling until the service is live.
`deployment.service.js` then re-runs the testing and security agents against the live URL and
attaches both runs to the `Deployment` record.

### Assertion types (the contract the LLM must emit)

```ts
type Assertion =
  | { kind: 'status';            expected: number }
  | { kind: 'responseTimeUnder'; ms: number }
  | { kind: 'jsonPathExists';    path: string }
  | { kind: 'jsonPathEquals';    path: string; value: unknown }
  | { kind: 'jsonPathType';      path: string; type: 'string'|'number'|'boolean'|'object'|'array'|'null' }
  | { kind: 'headerPresent';     name: string }
  | { kind: 'headerEquals';      name: string; value: string }
  | { kind: 'bodyMatches';       pattern: string }   // RE2-safe subset only
```

Evaluated deterministically in `run_test_case`. **The LLM proposes assertions; it never judges
whether one passed.** That separation is what makes a result a measurement rather than an
opinion.

`bodyMatches` compiles a user- or LLM-supplied regex, so the pattern length is capped, nested
quantifiers are rejected and execution is time-boxed. Anything less is a ReDoS waiting to happen.

---

## 7. Egress guard: SSRF, and why it matters

**This is the most important security control in the system.** AGENTIQ accepts a URL from a user
and fetches it from the server. Without controls that is a textbook SSRF proxy: a user asks it to
fetch `http://169.254.169.254/latest/meta-data/` and the cloud credentials leave the building.

Every outbound request, from every tool, goes through `mcp/egress.js`:

1. **Scheme allow-list:** `http` and `https` only.
2. **Resolve DNS first, then validate every resolved address.** Validating the hostname is not
   enough, because an attacker controls DNS and can point `evil.example` at `127.0.0.1`.
3. **Blocked ranges** (`mcp/ipRules.js`):
   - IPv4: loopback `127.0.0.0/8` · private `10/8` `172.16/12` `192.168/16` · link-local
     `169.254/16` (**the cloud metadata range**) · `0.0.0.0/8` · carrier-grade NAT `100.64/10` ·
     multicast `224/4` · reserved and documentation ranges (`192.0.0/24`, `192.0.2/24`,
     `192.88.99/24`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `240/4`).
   - IPv6: loopback `::1` · unspecified `::` · unique-local `fc00::/7` · link-local `fe80::/10`.
     IPv4-mapped and IPv4-compatible addresses (`::ffff:127.0.0.1`) are unwrapped and re-checked
     as IPv4, and zone indices are stripped first.
   - Hostname suffixes: `.local`, `.localdomain`, `.internal`.
4. **Pin the resolved IP for the actual connection**, through the HTTP agent's `lookup`, so DNS
   cannot change between check and fetch (TOCTOU and DNS rebinding).
5. **At most 3 redirects**, each hop re-validated. A redirect to `169.254.169.254` is the classic
   bypass.
6. **Timeout 10 s**, **response cap 5 MB**, **per-host rate limit 5 requests per second**.
7. Blocked attempts write an audit record with `outcome: 'blocked_ssrf'`.

`ALLOW_PRIVATE_TARGETS=true` exists for local development against the fixture apps on
`localhost`. It is **off by default and refused entirely in production**, and even when it is on,
the link-local metadata range stays blocked.

Every blocked range has its own test in `server/tests/egress.test.js` and `ipRules.test.js`.

---

## 8. Auth

- One `User` model with `authProviders: [{ provider, providerId, email }]`, so one person signing
  in two ways is one account.
- `bcryptjs`, cost 12.
- JWT: HS256, 7-day expiry, `{ sub, email, iat, exp }`. **Boot fails if `JWT_SECRET` is unset**;
  there is no fallback constant.
- **Lazy Google strategy:** the Passport strategy registers only when both Google variables are
  present. Registering it unconditionally would crash a fresh clone on boot.
- `express-rate-limit` on `/api/auth/*`.
- OAuth redirect URIs come from configuration, never a hardcoded localhost.
- Email verification: tokens are hashed at rest, single use, and expire through a TTL index.
  Verification is advisory; see `services/verification.service.js`.

## 9. Data model

```
User               { _id, email, displayName, passwordHash?, authProviders[], avatarUrl?, role,
                     emailVerified, emailVerifiedAt?, createdAt, updatedAt }
EmailVerification  { _id, userId, email, tokenHash, usedAt?, expiresAt, createdAt }   // TTL on expiresAt
ApiSpec            { _id, userId, title, version, openapi, sourceUrl?, sourceFilename?,
                     raw?, byteSize, operations[], operationCount, securitySchemes, createdAt }
TestRun            { _id, userId, state, stateHistory[], specRef?, grounded,
                     target{ url, method, description, intendedPublic },
                     summary{ totalTests, passed, failed, errored, discarded, assertionsEvaluated,
                              findings{ critical, high, medium, low } },
                     functional[{ name, status, responseTimeMs,
                                  assertions[{ kind, expected, actual, pass }], explanation? }],
                     security[{ family, owasp, severity, vulnerable, payload, signal,
                                baseline, explanation, remediation }],
                     generation{ provider, model, inputTokens, outputTokens, costUsd,
                                 attempts, generationMs },
                     error?{ code, message }, startedAt, finishedAt }
AuditEvent         { see §5.3 }   // immutable
Deployment         { _id, userId, provider, repo, branch, serviceName, state, stateHistory[],
                     preflight, serviceId?, deployId?, liveUrl?, postDeployRunId?,
                     startedAt, finishedAt }
```

`raw` is kept only for small documents; larger ones keep just their extracted operations.
`TestRun.state` is one of `DRAFT`, `AWAITING_GRANT`, `CANCELLED`, `GENERATING`, `GEN_FAILED`,
`EXECUTING`, `EXEC_FAILED`, `SCANNING`, `EXPLAINING`, `COMPLETE`
(see [03](03_App_Flow.md), B7).

## 10. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | liveness, dependency status, LLM chain |
| `POST` | `/api/auth/register` · `/api/auth/login` · `/api/auth/logout` | email and password |
| `GET` | `/api/auth/me` | current user |
| `GET` | `/api/auth/google` · `/api/auth/google/callback` | Google OAuth |
| `POST` | `/api/auth/verify` · `/api/auth/verify/resend` | email verification |
| `POST` | `/api/runs` | full run: generate, execute, optionally scan |
| `GET` | `/api/runs` · `/api/runs/:id` | history and detail, scoped to the caller |
| `GET` | `/api/runs/stats` | dashboard aggregates |
| `GET` | `/api/security/families` | the probe families and their OWASP mapping |
| `POST` | `/api/security/scan` | scan only |
| `POST` | `/api/specs/import` | import an OpenAPI document by URL or upload |
| `GET` | `/api/specs` · `/api/specs/:id` | specs and their operations |
| `GET` | `/api/specs/:id/operations/:index/auth` | auth configuration derived from the spec |
| `POST` | `/api/request/send` | ad-hoc API client |
| `GET` | `/api/deployments/config` | whether Render is configured, and which families verify a deploy |
| `POST` | `/api/deployments/preflight` | read-only checks, nothing deployed |
| `POST` | `/api/deployments` | deploy, then verify the live URL |
| `GET` | `/api/deployments` · `/api/deployments/:id` | deployment history and detail |
| `GET` | `/api/mcp/tools` | **the live registry, with JSON Schemas** |
| `GET` | `/api/mcp/audit` | **the audit log, filterable** |
| `GET` · `POST` · `DELETE` | `/api/mcp/grants` | list, grant and revoke risk-class grants |
| `GET` | `/api/mcp/status` | tool count and each tool's risk class |
| `ALL` | `/api/mcp` | the streamable-HTTP MCP transport |

**Public:** `/api/health`, `/api/mcp/tools`, `/api/mcp/status`, `/api/security/families`, and the
auth routes that establish a session (register, login, logout, Google, verify). The tool registry
is public on purpose: anyone can inspect the contract. Everything else requires a Bearer token or
the session cookie.

Every response is `{ success, data }` or `{ success: false, error: { code, message, details? } }`: one
envelope, no exceptions.

## 11. Testing

- **Unit** (vitest): assertion evaluator, JSON normaliser, SSRF guard (one test per blocked
  range), permission gate, security classifiers, OpenAPI parser.
- **Integration** (supertest and `mongodb-memory-server`): auth, run lifecycle, audit
  completeness, registry endpoint, HTTP and stdio MCP transports.
- **End to end against fixtures:** full runs against `vulnerable-api` and `hardened-api`.
- **Architecture test:** `server/tests/architecture.test.js` scans `server/src/agents/**`,
  `controllers/**` and `routes/**` for any HTTP client or process API and **fails** the build if
  it finds one. It keeps the MCP claim from eroding under future edits.
- **Coverage gate:** 70% on `server/src/mcp/**` and `server/src/agents/**`, enforced in CI.
- LLM calls are stubbed in tests. CI never depends on a provider being up.

## 12. Config

Every variable is declared and validated with Zod in `server/src/config/env.js`, and documented
in `.env.example`. At boot the server prints a table of what is set and what is missing, then
exits non-zero if a required variable is absent or malformed.

```
Required     MONGO_URI  JWT_SECRET (at least 32 characters)
Server       NODE_ENV  PORT  CORS_ORIGIN  APP_BASE_URL  API_BASE_URL  LOG_LEVEL
LLM          LLM_PRIMARY=bedrock  LLM_FALLBACK=groq  AWS_REGION  BEDROCK_MODEL_ID
             BEDROCK_MODEL_EXPLAIN  GROQ_API_KEY  GROQ_MODEL  GROQ_MODEL_EXPLAIN
Google OAuth GOOGLE_CLIENT_ID  GOOGLE_CLIENT_SECRET        (optional; absence must not break boot)
Email        MAIL_DRIVER  GMAIL_USER  GMAIL_APP_PASSWORD  SMTP_URL  SMTP_HOST  SMTP_PORT
             RESEND_API_KEY  MAIL_FROM                     (optional)
Deployment   RENDER_API_KEY  RENDER_API_BASE               (optional)
Egress       EGRESS_TIMEOUT_MS=10000  EGRESS_MAX_BYTES=5242880  EGRESS_RPS_PER_HOST=5
             ALLOW_PRIVATE_TARGETS=false
```

AWS credentials are deliberately absent: they come from the default credential chain locally and
from an instance role in production. The frontend reads `VITE_API_URL`, the full API base URL
including the `/api` segment.

## 13. Deployment and cost

See [05_AWS_ARCHITECTURE.md](05_AWS_ARCHITECTURE.md) for hosting, CI/CD and the cost breakdown,
and [07_DEPLOYMENT_CHECKLIST.md](07_DEPLOYMENT_CHECKLIST.md) for the release checklist. The
architecture in this document (the MCP layer, egress guard, agent rules and data model) is
provider-agnostic.

Free-tier hosting cold-starts. `.github/workflows/keep-warm.yml` pings `/api/health` on a
schedule to keep the service awake.

## 14. Non-functionals

| | Target |
|---|---|
| p95 run latency (4 tests, no scan) | under 15 s |
| p95 security scan (6 families) | under 30 s |
| Dashboard first paint | under 2 s, warm |
| Outbound probe rate | at most 5 requests per second per host |
| Secrets in logs | zero: pino redaction on authorization headers, cookies, passwords and tokens |
| Accessibility | WCAG 2.1 AA |
| Browsers | the last 2 versions of Chrome, Firefox, Safari and Edge |
