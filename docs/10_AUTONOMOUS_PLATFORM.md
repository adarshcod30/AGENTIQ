# 10 · Autonomous platform: assessment and plan

> Working document for the evolution from the current URL-driven tool into an autonomous
> project → test → assess → deploy platform. It is the map for the phased implementation that
> follows, not a description of what is built today. Status of each phase is tracked in §H.

---

## A. Current architecture

What exists today, verified against the code.

**Shape.** A single Express 5 API (`server/`) and a React SPA (`web/`), one MongoDB, three agents,
a nine-tool MCP layer. Everything runs in one process.

**The request path is synchronous.** `POST /api/runs`, `POST /api/security/scan` and
`POST /api/deployments` each `await` the whole job inside the HTTP handler and return the finished
result. There is no queue, no worker, no background execution. A run that takes 30 seconds holds
the connection open for 30 seconds.

**The three agents are pure orchestration.** They contain no I/O by design, enforced by
`server/tests/architecture.test.js`, which fails the build if `axios`, `fetch`, `http.request`,
`node:net` or `node:child_process` appears under `agents/`, `controllers/` or `routes/`. Every
outbound request goes through an MCP tool.

- **Testing Agent** (`agents/testing.agent.js`) takes `{ url, method, description, count, operation }`.
  It asks the LLM for test cases, validates them against a Zod schema with one repair retry, then
  calls the `run_test_case` tool per case and collects per-assertion verdicts.
- **Security Agent** (`agents/security.agent.js`) takes `{ url, method, headers, body, intendedPublic,
  families }`. For each of six families it calls a `probe_*` tool, which sends a benign baseline
  then payloads over HTTP and classifies the difference.
- **Deployment Agent** (`agents/deployment.agent.js`) runs a read-only preflight against the GitHub
  API, then `deploy_service` against Render, then re-runs the other two agents against the live URL.

**The MCP layer is the strongest asset.** `mcp/registry.js` registers nine tools, each with a Zod
input and output schema. `withGuards` wraps every handler in a fixed chain: permission check →
schema validation → handler (which reaches the network only through `mcp/egress.js`) → exactly one
audit record in `finally`. Four risk classes (`local.compute`, `network.read`, `network.probe`,
`deploy.write`) gate what a tool may do; grants are per host and per session. The egress guard
resolves DNS, validates every address against a blocklist (loopback, private, link-local, and so
on), pins the IP for the connection, caps redirects and bytes, and rate-limits per host. The tools
are also served over HTTP and stdio, so an external MCP client can drive them.

**Data model.** `User`, `TestRun` (one row per run, every terminal state persisted), `ApiSpec`
(imported OpenAPI, parsed into operations), `AuditEvent` (append-only), `Deployment`,
`EmailVerification`. Runs and audit rows are scoped to the owning user.

**The nine tools:** `http_request`, `run_test_case`, `probe_sqli`, `probe_xss`, `probe_auth`,
`probe_cors`, `probe_headers`, `parse_openapi`, `deploy_service`.

---

## B. Gap analysis: what blocks autonomy

The single sentence that defines the gap: **the platform tests a URL a human typed, not a project it
discovered.** Concretely:

1. **No project concept.** Nothing reads a filesystem. There is no model of a repository, no
   ingestion, no workspace. Every flow starts from a URL string the user provides.
2. **No codebase understanding.** The Testing Agent's entire knowledge of an endpoint is the one
   sentence of intent the user types. It cannot read routes, controllers, schemas or models, so it
   cannot discover endpoints or infer what they should do.
3. **No route discovery.** `parse_openapi` can read a spec *if the project ships one*, but most
   student projects do not. There is no way to derive the API surface from the code.
4. **Security is DAST-only.** The six probes are black-box HTTP probes. There is no static analysis,
   no dependency audit, no secret scanning, no config or Dockerfile review. Whole OWASP categories
   in the request (IDOR, path traversal, command injection, insecure deserialization, dependency
   CVEs, hardcoded secrets) are unreachable by an HTTP probe alone.
5. **No orchestrator.** The three agents are invoked independently from three routes. Nothing chains
   discover → test → assess → analyze → report → deploy, and no consolidated report exists.
6. **Synchronous execution.** A multi-minute autonomous workflow cannot run inside an HTTP request.
   There is no job, no progress stream, no resume. This is the hard blocker for everything
   long-running.
7. **No local application lifecycle.** The platform cannot start, health-check or stop the user's
   app. It assumes the target is already running at a URL.
8. **In-memory grants and single-process state.** Grants live in a `Map`; a restart clears them, and
   a second instance would not share them. Fine for one machine, a blocker for the SaaS shape.
9. **Deployment is effectively Render-only.** The provider seam is a single base-URL swap, not a
   pluggable provider interface.

None of this is a defect in what exists. It is simply that the current system solves "test this
endpoint" and the goal is "understand and validate this project."

---

## C. Target architecture

The existing controls are the foundation. The new work sits *on top of* the MCP layer, never around
it: every new capability that touches a file, a process, or the network becomes a guarded tool.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Web SPA: project list · assessment run view (live phase timeline) · report │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │ HTTPS + JWT
┌───────────────────────────────▼────────────────────────────────────────────┐
│  API (Express)  routes · thin controllers                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ORCHESTRATOR   an Assessment state machine: DISCOVER → TEST → ASSESS →      │
│                 ANALYZE → REPORT → (approve) → DEPLOY → VERIFY               │
│                 emits progress events; resumable; one Assessment row         │
├─────────────────────────────────────────────────────────────────────────────┤
│  JOB QUEUE      long jobs run in a worker, not in the request                │
├─────────────────────────────────────────────────────────────────────────────┤
│  AGENTS (no I/O)   discovery · testing · security · deployment               │
├─────────────────────────────────────────────────────────────────────────────┤
│  ██ MCP TOOL LAYER ██  registry · risk classes · permission gate · audit    │
│    existing:  http_request run_test_case probe_* parse_openapi deploy_service│
│    new:       fs_read · code_search · ast_extract · discover_routes ·        │
│               app_lifecycle · dep_audit · secret_scan · sast_scan ·          │
│               config_scan · git_inspect                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  GUARDS   egress (SSRF) · NEW fs sandbox (workspace-jail) · NEW proc sandbox │
├─────────────────────────────────────────────────────────────────────────────┤
│  Project workspace (a directory) · local app process · MongoDB · LLM chain  │
└─────────────────────────────────────────────────────────────────────────────┘
```

Two new risk classes join the four that exist:

- `local.fs.read`: read files inside one project workspace, and nowhere else.
- `local.process`: start, signal and stop a child process for the project under assessment,
  inside limits (timeout, memory, no shell string).

Both are auto-granted for the project's own workspace and refused everywhere else, the same way
`local.compute` is auto-granted and `network.probe` never is. The filesystem jail is the exact
analogue of the egress guard: a path is resolved, checked to be inside the declared workspace root,
and refused otherwise, so a tool cannot read `~/.aws/credentials` any more than it can fetch the
metadata endpoint.

---

## D. Agent design

### Discovery Agent (new)

- **Responsibility:** turn a workspace directory into a structured model of the project: its
  framework, its API surface (routes with method, path, params, body schema, auth, and the
  controller/service/model chain behind each), its dependencies, its config, and how to run it.
- **Tools:** `fs_read`, `code_search`, `ast_extract`, `discover_routes`, `git_inspect`,
  `parse_openapi` (when a spec exists).
- **Method:** deterministic first. Framework detection reads `package.json`. Route discovery is an
  AST pass over the source (for Express: find `app`/`router` `.get/.post/...` calls and their path
  literals; extendable per framework), not an LLM reading files. The LLM is used only to *infer
  intent* ("what does `POST /api/patient` appear to do?") from the discovered code slice, and to
  decide which clarifying question to ask when intent is ambiguous.
- **Input:** `{ projectId, workspaceRoot }`. **Output:** a `ProjectModel` document: framework,
  `endpoints[]`, `dependencies[]`, `configFindings[]`, `runCommands`, `confidence` per endpoint,
  `clarifications[]` (questions for the user).
- **State:** none in the agent; the `ProjectModel` is persisted by the orchestrator.

### Testing Agent (evolved, not replaced)

- Keeps its current core (generate → validate → execute → per-assertion verdict) unchanged.
- Gains a new front end: instead of `{ url, description }` it can take a discovered `endpoint` from
  the `ProjectModel`. It grounds generation in the real route params, body schema and inferred
  intent, and picks test categories per endpoint rather than a fixed list (an endpoint with no auth
  requirement skips the auth-bypass cases; one with a numeric path param gets boundary cases).
- When the discovered intent confidence is below a threshold, it defers to the orchestrator to raise
  a clarification rather than guessing.
- **Input:** `{ endpoint, baseUrl }` or the existing `{ url, method, description }`.
  **Output:** unchanged `TestRun` shape.

### Security Agent (evolved into two lanes)

- **DAST lane:** the existing six probes, unchanged, now driven by discovered endpoints and the
  running local app rather than a single URL.
- **SAST lane (new):** static analysis over the workspace, orchestrating deterministic scanners
  through new tools: `dep_audit` (dependency CVEs, wrapping `npm audit`), `secret_scan` (hardcoded
  credential patterns), `sast_scan` (source patterns for injection, path traversal, command
  execution, weak crypto), `config_scan` (CORS, headers, cookie flags, Dockerfile, env handling).
- Both lanes emit the same finding shape (severity, component, evidence, why it matters, root cause,
  remediation, code reference, confidence), so the report treats them uniformly. Findings are
  de-duplicated and correlated (a DAST auth-bypass and a SAST missing-authorization on the same
  route become one finding with two pieces of evidence).
- **Confidence ladder:** `confirmed` (a probe demonstrated it) > `strong` (static pattern plus
  corroborating signal) > `potential` (single static pattern) > `informational`.

### Deployment Agent (evolved to pluggable providers)

- Keeps its phase structure (preflight → deploy → verify) and its `dryRun`.
- The Render specifics move behind a `DeploymentProvider` interface (`detectRequirements`,
  `authenticate`, `prepareConfig`, `deploy`, `pollStatus`, `fetchLogs`, `verify`). Render becomes
  the first implementation; Vercel, Railway and others are added as implementations without touching
  the agent.
- Adds failure diagnosis: on a failed build it collects logs through the provider, classifies the
  failure (missing env var, wrong build command, missing start script), proposes a safe config fix,
  and retries only after user approval for anything that changes behavior.

### Orchestrator (new, the keystone)

- Drives an `Assessment` through `DISCOVER → TEST → ASSESS → ANALYZE → REPORT → AWAITING_APPROVAL →
  DEPLOY → VERIFY → COMPLETE`, with failure branches at each phase that keep partial results.
- Runs as a job in a worker, emits a progress event per phase transition, and is resumable from its
  last completed phase.
- Interrupts the user only for the enumerated cases: ambiguous intent, missing credentials, provider
  choice, an env var it cannot infer, or a behavior-changing fix. Everything else it decides.

---

## E. MCP / tool architecture

New tools, each with a Zod schema, a risk class, and an audit row, exactly like the nine that exist.
Every one wraps a deterministic operation; the LLM never runs a raw shell command.

| Tool | Risk class | What it does | Determinism |
|---|---|---|---|
| `fs_read` | `local.fs.read` | Read one file inside the workspace jail | pure |
| `code_search` | `local.fs.read` | ripgrep over the workspace, structured hits | pure |
| `ast_extract` | `local.compute` | Parse a file (`@babel/parser` / `typescript`), return routes, exports, calls | pure |
| `discover_routes` | `local.fs.read` | Framework-aware route extraction over the workspace | pure |
| `git_inspect` | `local.fs.read` | Read-only git facts (tracked files, remotes, no secrets) | pure |
| `app_lifecycle` | `local.process` | Start / health-check / stop the local app, timeout-bounded | deterministic |
| `dep_audit` | `local.process` | `npm audit --json` (and equivalents), normalized | deterministic |
| `secret_scan` | `local.fs.read` | Credential-pattern scan over tracked files | pure |
| `sast_scan` | `local.fs.read` | Source-pattern scan (optionally Semgrep when installed) | pure |
| `config_scan` | `local.fs.read` | Parse config/Dockerfile/env for insecure settings | pure |
| `report_render` | `local.compute` | Assemble the consolidated report from stored results | pure |

The LLM reasons and sequences; these tools do the work. Route discovery, dependency audit, secret
scanning and test execution must never depend on LLM output, because their value is that they are
reproducible.

---

## F. Data flow: project to deployment

1. User registers a project by pointing at a local workspace directory. A `Project` row is created
   with the `workspaceRoot`.
2. User starts an assessment. An `Assessment` row is created and a job enqueued.
3. **DISCOVER:** the Discovery Agent builds the `ProjectModel` (framework, endpoints, deps, config,
   run commands). Ambiguities become `clarifications`.
4. If clarifications exist and block testing, the orchestrator pauses at `AWAITING_INPUT` and asks.
5. **TEST:** `app_lifecycle` starts the app; the Testing Agent generates and runs tests per
   discovered endpoint; results persist as `TestRun`s linked to the assessment.
6. **ASSESS:** the Security Agent runs both lanes against the workspace and the running app;
   findings persist.
7. **ANALYZE:** the orchestrator correlates test failures, security findings and config issues, and
   computes a deployment-readiness verdict.
8. **REPORT:** a consolidated report is rendered and stored.
9. **AWAITING_APPROVAL:** the user reviews. Behavior-changing fixes need explicit approval.
10. **DEPLOY:** the user picks a provider; the Deployment Agent deploys and diagnoses failures.
11. **VERIFY:** post-deploy health checks; the live URL and final status are returned.

The app is stopped and the workspace released in a `finally`, whatever the outcome.

---

## G. Security model

- **Local-only assessment, enforced not assumed.** The testing and security lanes run against the
  project's own workspace and its locally started app. The `app_lifecycle` tool binds and targets
  loopback only. The DAST probes keep the existing egress guard, which already refuses anything that
  is not the intended local target when `ALLOW_PRIVATE_TARGETS` gates it. The system is never
  pointed at an arbitrary Internet host.
- **Filesystem jail.** `local.fs.read` tools resolve every path and refuse anything outside the
  declared `workspaceRoot` (no `..` escape, no symlink escape, no absolute path outside the root).
  This is the filesystem analogue of the SSRF guard.
- **Process sandbox.** `local.process` tools spawn with an argument array (never a shell string),
  a timeout, a working directory pinned to the workspace, and a scrubbed environment. No tool
  constructs a command from LLM free text.
- **Credentials.** Deployment and cloud credentials are supplied per request or through the
  credential-request flow, never committed, never logged (the existing redaction paths extend to the
  new tools), and never returned in a report. The audit row stores a hash of tool input, never the
  raw input.
- **Approval gates.** `deploy.write` and any behavior-changing fix require an explicit, confirmed
  grant, exactly as `deploy_service` does today.

---

## H. Implementation plan

Each phase leaves the system runnable, keeps every existing test green, and is additive. The current
URL-driven flows keep working throughout.

**Phase 1 · Discovery foundation. DONE.**
Shipped: the filesystem jail (`mcp/fsJail.js`) and the `local.fs.read` risk class; the pure AST
route analyzer (`mcp/analysis/routes.js`) with router-identifier tracking and cross-file mount
composition; four tools (`fs_read`, `code_search`, `ast_extract`, `discover_routes`); the
`Project` and `Discovery` models; a no-I/O `discovery.agent.js`; `discovery.service.js`; and
`POST /api/projects`, `POST /api/projects/:id/discover`, `GET /api/projects[/:id]`. The
architecture guard now also bars `node:fs` from agents, routes and controllers. Discovery of the
vulnerable fixture returns its six routes with params and no LLM call; run against AGENTIQ's own
tree it recovers all 32 endpoints with full `/api/...` paths. 41 new tests; suite at 477 green,
coverage gate met, `npm audit` clean. The `ProjectModel` of §D is persisted as a `Discovery`
document.

Original plan for reference:
New: `Project` model, `ProjectModel` model, the filesystem jail (`mcp/fsJail.js`), the
`local.fs.read` risk class, and three tools: `fs_read`, `code_search`, `ast_extract`. A
`discover_routes` tool for Express. A `discovery.agent.js` that produces a `ProjectModel` from a
workspace. `POST /api/projects` and `POST /api/projects/:id/discover`.
- Interfaces: the `ProjectModel` schema; the fs-jail contract.
- Deps: none new (AST libs already present).
- DB: two collections.
- Tests: fs-jail refuses escapes; route discovery against the two fixture apps and one Express
  sample; the architecture guard extended to cover the new tools.
- Acceptance: pointing discovery at `fixtures/vulnerable-api` returns its real routes with methods
  and path params, with no LLM call.

**Phase 2 · Grounded testing. DONE.**
Shipped: `runTestingAgentForEndpoint` grounds generation in a discovered endpoint with per-endpoint category selection; the `app_lifecycle` tool and `local.process` risk class start/stop the app on loopback behind a process sandbox; the intent agent infers what an endpoint does and raises a clarification when ambiguous. Original plan:
The Testing Agent accepts a discovered `endpoint`; generation is grounded in real params and inferred
intent; test categories are chosen per endpoint. `app_lifecycle` tool starts/stops the local app.
- Acceptance: an assessment discovers and tests the fixture app end to end with no user-supplied URL.

**Phase 3 · Static security lanes. DONE.**
Shipped: `secret_scan`, `sast_scan`, `config_scan`, `dep_audit` tools with pure, tested cores; one shared finding shape with a confidence ladder; `runSecurityAssessment` runs both lanes, maps, de-duplicates and correlates. Original plan:
`dep_audit`, `secret_scan`, `sast_scan`, `config_scan` tools; the Security Agent gains the SAST lane;
findings are normalized, de-duplicated and correlated with DAST.
- Acceptance: the vulnerable fixture yields both a DAST finding and a corroborating SAST finding on
  the same route, merged into one.

**Phase 4 · Orchestrator and jobs. DONE.**
Shipped: the `Assessment` state machine and orchestrator (discover -> test -> scan -> analyze -> report), an in-process job queue, per-phase persistence with resume, a live timeline via polling, and the `/api/assessments` routes. Original plan:
The `Assessment` model and state machine; an in-process job queue and worker (no external broker for
local mode); a progress event stream; resume from last phase. Routes become thin enqueue calls.
- Acceptance: one `POST /api/assessments` drives discover → test → assess → analyze → report, with a
  live phase timeline, and resumes after a kill.

**Phase 5 · Consolidated report and approval. MOSTLY DONE.**
Shipped: `report.service.js` (readiness verdict + structured report) and the `report_render` tool (Markdown). The web report page and an explicit approval gate before DEPLOY remain, and belong with Phase 6. Original plan:
`report_render` tool; the report page in the web app; the approval gate.
- Acceptance: a single report shows discovered APIs, test results, findings by severity with
  evidence, recommended fixes, and a readiness verdict.

**Phase 6 · Pluggable deployment. DONE.**
Shipped: a `DeploymentProvider` interface and registry (`server/src/deploy/`), Render as the first implementation wrapping the existing tested orchestration, a Railway stub that proves the seam, provider-agnostic requirement detection and failure diagnosis (with behaviour-changing fixes flagged for approval), and provider selection through the routes. The two follow-ups are now done in Phase 7: the approval-gated auto-retry-with-fix (`server/src/deploy/retry.js`, `retryDeployment`, `POST /api/deployments/:id/retry`), and provider choice in the web UI. Original plan:
The `DeploymentProvider` interface; Render refactored behind it; failure diagnosis and safe retry.
Provider choice surfaced in the UI.
- Acceptance: Render still deploys through the new interface; a second provider stub proves the seam.

**Phase 7 · Hardening for multi-project / self-host. DONE.**
Shipped:
- Resource limits and process-group isolation for `local.process` (`procSandbox.js`): a heap cap via
  `NODE_OPTIONS`, a wall-clock lifetime backstop, detached spawning so the whole tree is reaped
  (`killTree`) rather than orphaning npm's child node, and a bounded stdout drain.
- Persistent, session-isolated grants (`Grant` model, `mcp/grantPersistence.js`): write-through to
  MongoDB with re-hydration on boot, so a grant survives a restart within its hour, keyed by
  (userId, sessionId) so concurrent assessments never read each other's approvals. The in-memory store
  stays the synchronous source of truth; a TTL index reaps expired rows.
- The BYOK config surface (`settings.service.js`, `GET /api/settings/config`, the Settings page): every
  capability, whether its keys are present, and how to obtain them. Presence only, never a value, per
  the §G credential model.
- The web project-list and live assessment run views, and provider choice plus the approval-gated retry
  on the Deploy page.
- Acceptance MET: `tests/assessment.isolation.test.js` runs two projects concurrently and proves neither
  sees the other's workspace, grants or findings.

Phases 1 to 5 deliver the autonomous local workflow. 6 and 7 make it a product.

---

## I. Feasibility

**Fully feasible, locally, now.**
- Route discovery for Express (AST), FastAPI and Flask (patterns), and Next.js (filesystem
  convention). A project that is several at once is discovered by all of them and merged.
- The filesystem jail and process sandbox (same pattern as the egress guard).
- `dep_audit` over `npm audit`, `secret_scan`, `config_scan`, pattern-based `sast_scan`.
- `app_lifecycle` for Node projects on loopback.
- The orchestrator, the in-process job queue, the consolidated report.
- Grounded, per-endpoint test generation.

**Feasible with limits.**
- Route discovery across *every* framework. Express, FastAPI, Flask and Next.js ship today; Fastify,
  NestJS, Spring and others still need their own extractor. Cross-package prefix composition in
  Python is a known gap (the within-file and router-level prefixes are composed). Frameworks with
  heavy runtime magic (decorator routing, dynamic mounts) may need a running-app probe as a fallback.
- Deep SAST. A real Semgrep ruleset beats hand-written patterns; make Semgrep an optional tool used
  when installed, with a lighter built-in fallback so the system runs without it.
- Intent inference. The LLM's guess about what an endpoint should do is a hypothesis, not ground
  truth; the clarification loop exists precisely because of this.

**Requires additional infrastructure (SaaS only, out of local scope).**
- Real sandboxing of *untrusted* project code (containers/microVMs per job). In local mode the code
  is the user's own, so the fs jail and process limits suffice. For SaaS, running strangers' code
  needs container isolation and is a project in itself.
- A durable job broker (Redis/BullMQ), object storage for reports, and per-tenant credential vaults.

**Should not be automated.**
- Applying behavior-changing code fixes without review. Propose and require approval, never
  auto-apply.
- Deploying without an explicit provider choice and confirmed credentials.
- Any assessment of a target the user does not control. The local-only enforcement is a hard line.

**Major risks.**
- Framework coverage is the long tail; discovery quality caps everything downstream.
- Starting an arbitrary local app reliably (ports, env, DB dependencies) is fiddly; `app_lifecycle`
  needs generous timeouts and clear failure reporting.
- Scope. This is a large build. The phase boundaries exist so each one is shippable alone and the
  effort can stop at any phase with a working system.

---

## J. Implementation

Proceeds phase by phase from §H, starting with Phase 1. Each phase is committed only on request,
keeps the suite green, and preserves the existing URL-driven flows.
