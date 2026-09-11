# 01 · Product requirements

### AGENTIQ: an agentic platform for API testing, security validation and deployment assistance

> **01** is what and why · **[02](02_TRD.md)** is how it is wired · **[03](03_App_Flow.md)** is
> how it behaves · **[04](04_App_UI.md)** is how it looks.

---

## 1. The one-sentence pitch

A developer pastes an API URL and a sentence of English, and gets back **executed** functional
tests, a **real** OWASP-informed security scan, and a deployment that re-validates itself, with
every action taken through a permissioned, audited MCP tool layer, so the answer to *"why did it
do that?"* is always on record.

Every feature below either serves that sentence or is out of scope.

## 2. The problem

Four problems, and the last one matters most:

- **Fragmented tooling.** Functional testing lives in Postman, security testing in ZAP, and
  deployment verification nowhere. Three tools, three mental models, no shared context. A
  developer who wants to know "is this endpoint correct *and* safe *and* live?" runs three
  workflows and correlates the results by hand.
- **Manual authoring cost.** Writing assertions by hand is slow and biased by whatever the
  author happened to think of. Boundary and negative cases are exactly the ones people skip.
- **No semantic layer.** Existing tools operate on syntax: a URL, a schema, a payload. None of
  them understand *intent*. "This endpoint should reject a login with a valid email but the wrong
  password" is not expressible in Postman without writing the test yourself.
- **Unaccountable automation.** The moment an LLM takes actions against a live endpoint, you
  have a machine that fires HTTP requests on someone's behalf. Without a permission model and an
  audit trail, that is not a testing tool, it is a liability. Most LLM-agent demos ignore this
  entirely.

The last point is what separates this from a wrapper. **The core idea is not "an LLM writes
tests". It is "an LLM takes actions through a schema-validated, permission-gated, fully audited
tool layer, and the whole trace can be reconstructed."**

## 3. How it works

A user describes an endpoint: a URL and a sentence of intent, or an operation picked from an
imported OpenAPI specification. The **Testing Agent** asks an LLM for test cases, validates them
against a schema, and executes each one through the `run_test_case` tool. The **Security Agent**
runs six probe families through their own tools. The **Deployment Agent** deploys a repository
to Render and then points the other two agents at the URL that went live.

Every tool call passes through the same chain: schema validation, a permission check against
the user's grants, the SSRF egress guard, and an append-only audit record. Assertions are judged
deterministically by code, never by the model.

## 4. Goals

1. A **real MCP tool layer**. Every agent action goes through a registered tool with a declared
   input and output schema, a permission check and an audit record. No exceptions, no side
   channels.
2. A **Security Agent that actually fires payloads**, maps findings to the OWASP API Security Top
   10 (2023), and controls false positives well enough to publish a measured false-positive rate.
3. Test generation **grounded in OpenAPI specifications** when one is available, falling back to
   description-driven generation when it is not.
4. A **Deployment Agent** that genuinely deploys to Render and re-runs the Testing and Security
   agents against the live URL.
5. **Only real data** in the UI, on a light, professional interface.
6. An **honest, reproducible evaluation**: a measured number, not a demo screenshot.
7. A repository that is **clone-and-run** on macOS, Linux and Windows with no code edits.

### Non-goals

- **Model fine-tuning.** Grounding generation in the API's own specification does the job
  without a training corpus.
- **A browser extension for traffic capture.** A separate product.
- **Graph-based stateful test orchestration** (login, then token, then protected-call chains),
  with one exception: a single-hop auth token handoff is in scope, because the auth probe needs
  it.
- **A vector database or embedding-based RAG.** Retrieval here means the endpoint's own
  specification. A vector store adds infrastructure the problem does not need.
- **Destructive security testing.** No DELETE against arbitrary hosts, no data exfiltration, no
  actual exploitation. Detection only. This is a hard ethical boundary, not a preference.
- **Native mobile apps.** Responsive web only.
- **Multi-user teams, organisations and RBAC.** One user owns their runs.

## 5. Who uses it

| Persona | What they want | What they get |
|---|---|---|
| **Backend developer** (primary) | "Did I break the contract?" in under a minute | Paste a URL and intent, get executed tests with real assertions |
| **Solo developer** (primary) | Security awareness without learning ZAP | Six probe families with plain-English findings and remediation |
| **Reviewer or security lead** | Evidence that the claims are true | Audit log, Tool Registry page, evaluation numbers, one-command setup |

**Design for the reviewer.** If a claim about the product cannot be demonstrated in one click
from the running app, either build the click or drop the claim.

## 6. Features

Priorities: **P0** is core to the product · **P1** is important but separable.

---

### F1 · MCP tool layer: P0

The most important feature. Everything else routes through it.

An MCP server exposes the platform's capabilities as **registered tools**. Agents never call an
HTTP client directly; they call a tool. Each tool declares a Zod input schema and an output
schema. Every invocation is permission-checked and written to an audit collection.

**Registered tools:**

| Tool | Purpose | Risk class |
|---|---|---|
| `http_request` | Execute one arbitrary HTTP request, return status, headers, body and timing | `network.read` |
| `run_test_case` | Execute a test case and evaluate its assertions | `network.read` |
| `probe_sqli` | Inject SQL injection indicator payloads, fingerprint database errors | `network.probe` |
| `probe_xss` | Inject a reflection payload, check for unescaped echo | `network.probe` |
| `probe_auth` | Re-request with credentials stripped and forged, compare | `network.probe` |
| `probe_cors` | Inspect the CORS policy for a permissive origin with credentials | `network.read` |
| `probe_headers` | Check HSTS, CSP, X-Content-Type-Options, X-Frame-Options | `network.read` |
| `parse_openapi` | Parse and dereference an OpenAPI 3.x document | `local.compute` |
| `deploy_service` | Create or trigger a Render deployment | `deploy.write` |

**Acceptance criteria:**
- `GET /api/mcp/tools` returns the live registry with full JSON Schemas, generated from the Zod
  definitions. Never hand-written, or it will drift.
- A tool call with a malformed input is rejected by schema validation *before* any network I/O.
- A tool in a risk class the user has not granted returns a permission error and writes a
  `denied` audit record.
- Every invocation writes `{ runId, tool, riskClass, inputHash, outcome, durationMs, ts }`.
- The UI has a **Tool Registry** page listing every tool, its schema and its risk class, and an
  **Audit Log** page showing real invocations. *These two pages are how the claim gets checked.*

> **Design note:** the permission grant is per session and per risk class, not per tool. Asking a
> user to approve every tool individually is theatre; asking them to approve "this app may send
> probe traffic to hosts you nominate" is a real decision.

---

### F2 · Testing Agent: P0

Natural-language intent plus endpoint metadata, turned into executable test cases, turned into
executed results.

- **Multi-assertion.** Not just the status code. Supported: `status`, `responseTimeUnder`,
  `jsonPath exists`, `jsonPath equals`, `jsonPath type`, `headerPresent`, `headerEquals`,
  `bodyMatches`. A pass rate built on status codes alone carries almost no information.
- **Spec-grounded when a spec exists** (see F4).
- **Deterministic normalisation.** Models wrap JSON in code fences, add prose before it, emit
  trailing commas and use smart quotes; repairing that is worth doing. What is never repaired is
  the *meaning* of an assertion: rewriting `GET` + `expected 400` into `expected 200` would
  inflate pass rates.
- **Structured output.** The provider's JSON mode, validated against a Zod schema. Unrecoverable
  cases are discarded, and *the discard count is reported* rather than hidden.
- **Bounded retry.** One repair attempt on invalid JSON, then a loud failure. No silent fallback
  that fabricates test cases, which would make a failure look like a success.

**Acceptance criteria:**
- Given a URL, method and description, returns at least 4 structurally valid cases covering at
  least one positive, one negative and one boundary case.
- Every executed case reports expected vs actual **per assertion**, not per case.
- Generation failure surfaces as a visible error, never as fabricated tests.
- The discarded case count is shown in the run summary.

---

### F3 · Security Agent: P0

**Six probe families, each mapped to the OWASP API Security Top 10 (2023):**

| Probe | OWASP | Detection signal |
|---|---|---|
| SQL injection | API8:2023 Security Misconfiguration | Database error fingerprints (MySQL, PostgreSQL, SQLite, MSSQL, Oracle, SQLSTATE, ODBC) **or** a differential response between benign and payload requests |
| Reflected XSS | API8:2023 | Payload echoed unescaped in an HTML-like response |
| Broken authentication | API2:2023 Broken Authentication | Credentials stripped, yet still 2xx, **and** the response materially differs from an anonymous baseline |
| CORS misconfiguration | API8:2023 | `Access-Control-Allow-Origin: *` **with** `Allow-Credentials: true`, or origin reflection |
| Missing security headers | API8:2023 | HSTS, CSP, X-Content-Type-Options, X-Frame-Options absent |
| Rate limiting absent | API4:2023 Unrestricted Resource Consumption | N rapid requests, all 2xx, no `429`, no `Retry-After` |

**The false-positive problem is the actual engineering here.** Two mechanisms:

1. **Baseline differential.** Every probe first sends a benign request and stores the baseline
   (status, length, content-type, timing band). A finding requires a *material deviation* from
   baseline, not an absolute condition. An endpoint that returns 500 for everything is broken,
   not injectable.
2. **Explicit endpoint intent.** The user declares whether the endpoint is *intended to be
   public*. Without that declaration an auth probe flags every public API as vulnerable. A
   public endpoint returning 200 anonymously is **correct behaviour**, and the tool says so.

**Every finding carries:** severity (critical, high, medium, low), OWASP category, the exact
payload sent, the observed signal, a plain-English explanation and a remediation sentence.

**Hard safety rules, non-negotiable:**
- Read-only and non-destructive. Never `DELETE`, never `DROP`, never any data modification beyond
  what a single benign request causes.
- Outbound probe traffic is rate-limited (default at most 5 requests per second per host).
- **Private and link-local address space is refused**; see the SSRF section in
  [02](02_TRD.md#7-egress-guard-ssrf-and-why-it-matters). A tool that fetches user-supplied URLs
  from a server is an SSRF engine unless something stops it.
- The user explicitly acknowledges the first scan of any new host.

**Acceptance criteria:**
- Against a deliberately vulnerable fixture app (see F10), detects SQL injection, XSS, broken
  authentication, CORS misconfiguration and missing headers.
- Against a hardened version of the *same* app, reports **zero** findings.
- Against public APIs declared "intended public", reports zero auth findings.
- The measured false-positive rate is published in the evaluation. A real number beats a claim.

---

### F4 · OpenAPI ingestion: P0

Retrieve the endpoint's declared contract, and ground generation in it.

- Import a spec by URL or file upload (OpenAPI 3.0 or 3.1, JSON or YAML).
- Parse, dereference `$ref`s, validate.
- List operations; the user picks one or many.
- The generation prompt is grounded in the operation's real parameters, request schema, response
  schemas and declared status codes.
- Security schemes in the spec pre-populate the auth configuration.

**Acceptance criteria:**
- Handles a real-world spec (the Petstore 3.1 spec plus one large public spec).
- Spec-grounded generation produces assertions referencing **declared** response fields, and
  this is measured against description-only generation on the F10 harness.
- Malformed spec → clear parse error naming the offending path, not a stack trace.

> This makes for the cleanest measurement in the evaluation: *the same generator, with and
> without spec grounding, measured on the same benchmark.*

---

### F5 · Deployment Agent: P1

- The Render API key is read from the server environment. It is never accepted as tool input and
  never logged.
- Preflight: repository reachable, branch exists, build command present, required environment
  variables declared.
- Trigger the deploy through the Render API; poll its status.
- **On success, automatically re-run the Testing Agent and Security Agent against the live URL**
  and attach the results to the deployment record.

That last bullet is the whole point. A deploy button on its own adds nothing; a deployment that
verifies itself does.

**Acceptance criteria:** one end-to-end run, from repository to live URL to post-deploy test and
scan to a stored record, visible in history.

---

### F6 · Dashboard and history: P0

Every number comes from MongoDB.

- KPI cards: total runs, tests executed, pass rate, open findings by severity, median latency,
  all real aggregates over the signed-in user's runs.
- Run pulse: passed and failed by day over the last 14 days, from a real aggregation pipeline.
- Recent activity: real runs, with click-through to detail.
- An empty state for a new account that says what to do next, not a zero-filled chart.

**Acceptance criteria:** a brand-new account shows honest zeros and a call to action. Every
number traces to a query.

---

### F7 · Auth and account: P0

- Email and password sign-in, plus Google OAuth 2.0.
- One `User` model with an `authProviders` array, so one person signing in two ways is one
  account.
- No fallback JWT secret: the server refuses to boot if `JWT_SECRET` is unset.
- The server boots fully without Google OAuth configured (the strategy registers lazily).
- Rate-limited auth endpoints.
- Email verification with hashed, single-use tokens. Verification is advisory: an unverified user
  can still sign in, and the UI shows a banner.

---

### F8 · API client: P1

An ad-hoc request page: method, URL, headers and body in; status, duration, size, headers and
body out. It goes through the `http_request` tool like everything else, so a new host triggers
the permission sheet, and the response shows the IP address the egress guard resolved and pinned
the connection to.

---

### F9 · Explainability and audit: P0

- **Run detail** shows every assertion with expected vs actual and, for failures, an
  LLM-generated explanation. Explanations are budgeted per run, never per process.
- **Audit Log page:** a filterable list of tool invocations: tool, risk class, target host,
  outcome, duration, timestamp.
- **Tool Registry page:** every registered tool with its live JSON Schema.
- **A "why?" affordance on every finding:** payload sent, signal observed, baseline compared
  against.

The principle throughout: *nothing is a black box.*

---

### F10 · Evaluation harness: P0

A pass rate over a handful of GET requests measures almost nothing. The harness replaces that
with a real measurement.

**Two fixture apps** (small Express services, in-repo, under `fixtures/`):
- `vulnerable-api`: deliberately vulnerable. String-concatenated SQL, unescaped reflection, no
  auth on a privileged route, `ACAO: *` with credentials, no security headers, no rate limit.
- `hardened-api`: the same routes and contract, with every defect fixed.

**What is measured:**
1. **Security detection:** true positives on `vulnerable-api`, false positives on
   `hardened-api`. Precision and recall per probe family.
2. **Test-generation adequacy:** the hardened app is seeded with N deliberate behavioural
   mutations (wrong status code, missing field, off-by-one boundary, wrong content type), and the
   score is the fraction of mutations the generated suite kills. This adapts the mutation-score
   methodology from RESTestBench (arXiv 2604.25862).
3. **Grounding ablation:** the same measurement with spec grounding on and off.
4. **Cost and latency:** tokens and wall-clock time per run.

**Acceptance criteria:** `npm run evaluate` produces a reproducible results table. Whatever the
number is, report it: a measured 61% is a stronger result than an unmeasured claim of success.

---

## 7. What "good" looks like

| Metric | Target | How measured |
|---|---|---|
| Clone to running | At most 5 minutes, zero code edits, on macOS, Linux and Windows | Fresh clone on a clean machine |
| Server boots without optional config | Always | No `GOOGLE_CLIENT_ID`, still boots |
| Generated cases structurally valid | At least 95% | Harness over 50 generations |
| Security false positives on `hardened-api` | 0 findings | F10 harness |
| Security recall on `vulnerable-api` | At least 5 of 6 families | F10 harness |
| Mutation score, spec-grounded | Reported as measured, compared with ungrounded | F10 harness |
| Every agent action audited | 100% | Audit count equals tool-call count |
| p95 run latency (4 tests, no scan) | Under 15 s | Instrumented |
| Running cost | Measured per run | Token counts times list price, in the evaluation; hosting in [05](05_AWS_ARCHITECTURE.md) |

## 8. Risks

| Risk | Mitigation |
|---|---|
| **An LLM provider goes down, rate-limits, or retires a model** | Two providers behind one interface, with Bedrock primary and Groq as fallback. Model ids are configuration, not code. No anonymous third-party LLM proxy is ever in the chain: it has no place in a security tool. |
| **False positives erode trust in every finding** | A baseline differential on every probe, the `intendedPublic` declaration, and a false-positive rate measured against a hardened fixture and published. |
| **The server becomes an SSRF proxy** | The egress guard: scheme allow-list, DNS resolution with every address validated, IP pinning against DNS rebinding, a per-host rate limit, and redirect re-validation. |
| **An agent or route bypasses the tool layer** | `server/tests/architecture.test.js` fails the build if agents, routes or controllers import an HTTP client. |
| **Leaked credentials** | No fallback secrets, secrets only in the environment, and redaction on every log path. |
| **Scope creep** | The non-goals in §4 are binding. |
