# 03 · How it behaves

### Sitemap, journeys, state machines, and every state the UI handles

> Companion to [01_PRD.md](01_PRD.md) and [02_TRD.md](02_TRD.md). Visual language lives in
> [04_App_UI.md](04_App_UI.md). **Part E** at the end is a demo walkthrough of the paths that
> matter most.

---

## PART A: Structure

## A1. Sitemap

```
/                      Landing                    public
/login  /signup        Auth                       public
/google-success        OAuth token handoff        public, transient

── authenticated shell ─────────────────────────────────────────
/dashboard             Overview, real aggregates
/run                   Test Runner            ← primary workflow
/run/:id               Run detail             ← per-assertion evidence
/security              Security Scanner
/specs                 API Specs (list + import)
/specs/:id             Spec detail, operation picker
/client                API Client (Postman-like)
/history               All runs, filterable
/deploy                Deployment
/tools                 Tool Registry          ← proves the MCP claim
/audit                 Audit Log              ← proves the MCP claim
/settings              Profile, providers, keys, grants
/about                 What this is, what is honest about it
```

Two navigation groups, and the grouping is itself an argument:

- **WORK**: Dashboard · Test Runner · Security · Specs · API Client · History · Deploy
- **TRUST**: Tool Registry · Audit Log · About

The TRUST group is not filler. It is where anyone goes to check whether the architecture claim is
real, and putting it in the primary navigation says the product expects to be checked.

## A2. Navigation rules

- Persistent left sidebar (collapsible ≥ 1280px, drawer below).
- Topbar: breadcrumb, global "New run" action, user menu. **No decorative status badges.** Any
  status shown is derived from real state, never a static chip.
- Deep-linkable: every run, spec and filter combination has a URL.
- Unauthenticated access to a protected route → redirect to `/login?next=<path>`, and honour `next`
  after login.
- 401 from any API call → clear auth, redirect to login, toast "Session expired".

---

## PART B: Journeys

## B1. First run: the one that has to be perfect

The single most-walked path in your demo.

```
1. /run  →  form: API URL · Method · Description
                   [ ] Attach a spec (optional)
                   [ ] This endpoint is intended to be public
                   [ ] Also run a security scan

2. Submit → host is new → PERMISSION SHEET
   ┌──────────────────────────────────────────────────────────┐
   │  Allow AGENTIQ to send requests to  api.example.com ?     │
   │                                                           │
   │  ✓ network.read   benign requests, read responses         │
   │  ☐ network.probe  attack-indicator payloads (SQLi, XSS)   │
   │                                                           │
   │  Only scan hosts you own or are authorised to test.       │
   │                     [ Cancel ]  [ Allow for this session ] │
   └──────────────────────────────────────────────────────────┘

3. Live progress: one row per step, streamed, never a bare spinner
   ✓ Generating test cases            1.8s   (llama-3.1-8b-instant, 1,240 tok)
   ✓ Executing 4 cases                3.1s   3 passed · 1 failed
   ⟳ Security scan: 4 of 6 families
   ○ Explaining failures

4. Results: summary strip, then Functional / Security tabs

5. Auto-saved. URL becomes /run/:id
```

**Non-negotiables on this path:**
- The permission sheet appears **before** any packet leaves the server, and `network.probe` is
  unchecked by default. This is the moment the architecture becomes visible to a human: do not
  reduce it to a toast.
- Progress is per-step and honest. If generation takes 8 seconds, show 8 seconds elapsing.
- **Generation failure is an error, not a fallback.** Canned test cases would make a broken run
  look like a successful one. Show: "Test
  generation failed: the model returned malformed JSON twice. [Retry] [View raw response]".

## B2. Reading a result

Summary strip: `4 tests · 3 passed · 1 failed · 0 discarded · 2 findings · 4.9s · 1,240 tokens`

**Functional tab**: one card per case, collapsed to name + verdict + duration. Expanded:

```
▾ Rejects login with valid email, wrong password          FAIL   612ms
  POST https://api.example.com/auth/login
  Intent: verifies wrong credentials are refused, not accepted

  ASSERTIONS
  ✗ status                  expected 401        actual 200
  ✓ responseTimeUnder       expected < 1000ms   actual 612ms
  ✗ jsonPathExists          $.error             not present

  WHY THIS FAILED
  The endpoint returned 200 with a session token for an invalid password,
  which means authentication is not being enforced on this route. Expected
  401 with an error body.                                   [ Open in API Client ]
```

Expected vs actual **per assertion**. Results built on status codes alone carry very little
information.

**Security tab**: findings sorted by severity, each expandable:

```
▾ HIGH   SQL injection indicator          API8:2023 Security Misconfiguration
  PAYLOAD    ' OR '1'='1        (field: username)
  SIGNAL     Response contained "SQLSTATE[42000]": a MySQL error fingerprint
  BASELINE   Benign request: 200, 1,204 bytes, 118ms
             Payload request: 500, 3,891 bytes, 132ms
  MEANING    Input appears to be concatenated into a SQL statement rather
             than parameterised.
  FIX        Use parameterised queries / prepared statements. Never build SQL
             by string concatenation.
                                        [ View in audit log ]  [ Re-run probe ]
```

A finding with no payload and no baseline is not a finding. Show the evidence or do not make the
claim: this is the "why?" principle applied to security output.

**Clean result** is a designed state, not an empty list: a green panel, the six families listed with
ticks, and the sentence *"6 checks run, no indicators found. This is not a guarantee of security.
See About for what is and is not covered."* That last clause matters: a scanner that implies
completeness is overclaiming.

## B3. Spec-grounded run

```
/specs → Import (URL or file) → parse → operation list
       → pick GET /pets/{petId} → "Generate tests"
       → /run pre-filled: URL, method, parameters, declared responses,
                          security scheme, and a "Grounded by: Petstore v3.1" chip
```

On the results page, show the chip. In your evaluation you claim grounding helps; the UI should
make it visible which mode produced a given run.

**Parse failure** names the path: *"Could not parse: `$.paths./pets.get.responses`: expected an
object. Line 214."* Never a raw stack trace.

## B4. Security-only scan

`/security` → URL + method + optional body/headers + **"intended to be public"** → permission sheet
→ six families run in parallel with per-family progress → findings.

The public checkbox is load-bearing: without it, the auth probe would report every public API as
having broken authentication.

## B5. Deploy

```
Connect Render key → repo + branch + platform → PRE-FLIGHT
  ✓ Repository reachable        ✓ Branch exists
  ✓ Build command detected      ⚠ 2 env vars declared, not set
→ [Deploy] → poll status → live URL
→ POST-DEPLOY VERIFICATION (automatic)
    ✓ Health check 200
    ✓ Functional suite re-run     8/8 passed
    ✓ Security scan re-run        0 findings
→ Deployment record, linked to both runs
```

When `RENDER_API_KEY` is not configured, `/deploy` says so plainly instead of offering a form that
cannot work. **A page that says "not configured" is honest; a page that pretends is not.**

## B6. Tool Registry & Audit: the proof journey

`/tools`: a table of all nine tools: name, description, risk class chip, and an expandable live
JSON Schema fetched from `/api/mcp/tools`. A note at the top: *"Generated from the running server's
tool registry. Nothing on this page is hardcoded."*

`/audit`: reverse-chronological invocations: timestamp, tool, risk class, target host, outcome
chip, duration. Filter by run, tool, outcome. `blocked_ssrf` and `denied` rows render in the danger
tone. **Those rows are the clearest evidence in the app**, because they prove the guard fires. A
denied grant, or a request to a blocked address, produces one immediately.

---

## B7. Run lifecycle state machine

```
        ┌──────────┐
        │  DRAFT   │  form being filled
        └────┬─────┘
             │ submit
        ┌────▼──────────────┐  user cancels / denies
        │ AWAITING_GRANT    │──────────────────────► CANCELLED
        └────┬──────────────┘
             │ granted
        ┌────▼──────┐  malformed JSON ×2   ┌─────────────┐
        │GENERATING │──────────────────────►│GEN_FAILED   │ terminal, visible error
        └────┬──────┘                       └─────────────┘
             │ cases valid
        ┌────▼──────┐  network unreachable  ┌─────────────┐
        │ EXECUTING │──────────────────────►│ EXEC_FAILED │ partial results kept
        └────┬──────┘                       └─────────────┘
             │
      scan? ─┴─ yes ──► ┌──────────┐ ──► ┌────────────┐ ──► ┌──────────┐
             no ──────► │ SCANNING │     │ EXPLAINING │     │ COMPLETE │
                        └──────────┘     └────────────┘     └──────────┘
```

**Rules:** every terminal state persists a `TestRun`: a failed run is data, not a void. Partial
results are always kept and labelled. `EXPLAINING` is best-effort with a 5 s timeout; it may never
block completion. **The `explanationUsed` flag is per-run, held in run scope, never a module-level
global.** (A module-scoped flag, never reset, would make explanations fire once per server
process.)

---

## PART C: States every screen handles

Not optional. Every screen ships four states, and reviewers notice the ones you skipped.

| Screen | Empty | Loading | Error | Populated |
|---|---|---|---|---|
| Dashboard | "No runs yet: start your first test run" + CTA | KPI + chart skeletons | "Couldn't load stats" + Retry | Real aggregates |
| Test Runner | Clean form, example placeholder | Per-step progress rows | Named failure + Retry + raw response | Results tabs |
| Run detail | n/a | Skeleton cards | "Run not found" + back | Assertions |
| Security | Form, six families listed as "not yet run" | Per-family progress | Per-family error, others continue | Findings or clean panel |
| Specs | "No specs imported" + import CTA | Parse progress | Parse error with path + line | Operation list |
| History | "No runs yet" | Row skeletons | Retry | Filterable table |
| Audit | "No tool invocations yet" | Row skeletons | Retry | Event rows |
| Tools | never empty: registry always has 9 | Skeleton | "Server unreachable" | Registry table |
| Deploy | "No deployments" or the honest scoped-out notice | Poll progress | Provider error verbatim | Deployment record |

**Skeletons, not spinners.** A spinner says "something is happening"; a skeleton says "here is what
is about to arrive". One exception: an indeterminate step inside the run progress list may use a
small inline spinner on its row.

## PART D: Edge cases to handle explicitly

| Case | Behaviour |
|---|---|
| Target unreachable / DNS fails | Test fails with `NETWORK_ERROR`, not a crash. Assertion `actual` = the error message. |
| Target returns HTML not JSON | `jsonPath*` assertions fail gracefully with "response was not JSON". |
| Target takes > 10 s | Egress timeout. Case fails with `TIMEOUT`. |
| Response > 5 MB | Truncated at the cap; recorded as truncated; assertions evaluate on what arrived. |
| User targets `localhost` / `169.254.169.254` | **Blocked by egress guard.** Message names the reason: *"Private and link-local addresses are blocked to prevent SSRF."* Audit row written. |
| LLM rate-limited (429) | Fall back to secondary provider; if both fail, `GEN_FAILED` with a clear message and a retry. |
| LLM returns valid JSON, wrong shape | Zod rejects; one repair retry; then discard, and count the discard in the summary. |
| Session expires mid-run | Run completes server-side; user re-logs in and finds it in history. |
| Very large spec | Accepted. Over 256 KB only the extracted operations are stored, and 500+ operations trigger a warning about generation cost. |

**Not yet handled:** an idempotency key on run submission (a double submit starts two runs), a
per-user limit on concurrent runs, and pagination of a very long operation list.

## PART E: Demo walkthrough

Ten minutes, and every claim in these docs is reachable from here.

1. **(0:00) About page.** What this is, what it covers and what is out of scope. Leading with the
   limitations makes every later claim more credible.
2. **(1:00) Tool Registry.** Nine tools, live schemas, risk classes. *"Nothing on this page is
   hardcoded: it is fetched from the running server's MCP registry."*
3. **(2:00) A run on the vulnerable fixture.** Permission sheet: pause here and explain it.
   Watch the steps stream. Open a failing assertion and read the expected-vs-actual.
4. **(4:30) Security scan, same target.** Expand a SQLi finding: payload, signal, baseline,
   remediation.
5. **(6:00) Same scan against the hardened fixture.** Zero findings. *"Same six probes, same
   contract, defects fixed: this is the false-positive control."*
6. **(7:00) Audit Log.** Every invocation from the last five minutes. Point at the `blocked_ssrf`
   row: *"That is the SSRF guard refusing a link-local target."*
7. **(8:00) Evaluation table.** Real numbers, and `npm run evaluate` reproduces them.
8. **(9:00) Connect an external MCP client** and call `probe_headers` against the fixture. *"It is
   not just built on MCP: it is an MCP server."* Optional, but it is the moment that lands.

**Before a demo:** warm the deployment a few minutes ahead, run `npm run fixtures` so both fixture
apps are up, and have the evaluation open in a tab. A run with one failing assertion and one
blocked request makes the History and Audit Log pages worth showing.
