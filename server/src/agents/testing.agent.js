/**
 * TESTING AGENT: docs/01_PRD.md F2, docs/02_TRD.md §6.
 *
 * ⚠️ THIS FILE PERFORMS NO I/O. It may not import axios, fetch, node:http, or
 * any HTTP client. server/tests/architecture.test.js fails the build if it
 * does. Every request this agent causes is made by the `run_test_case` MCP
 * tool, which is schema-validated, permission-checked, SSRF-guarded and
 * audited. That separation is the core of the design.
 *
 *   - Multi-assertion, not status-code-only. A pass rate built on status codes
 *     alone carries almost no information.
 *   - NO hardcoded fallback cases. If the model fails, the run fails visibly;
 *     canned "valid request" tests would make a broken run look successful.
 *   - `discarded` is reported, not hidden.
 *   - The LLM PROPOSES assertions; run_test_case DECIDES pass/fail.
 */
import { z } from 'zod';
import { generateJSON } from '../services/llm.js';
import { assertionSchema } from '../mcp/tools/run_test_case.js';

/** What the model must produce. Anything else is discarded and counted. */
export const generatedCaseSchema = z.object({
  name: z.string().min(1).max(160),
  intent: z.string().min(1).max(400),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * A GET case has no body, and models overwhelmingly express that as
   * `"body": null` rather than by omitting the key. `.optional()` alone rejects
   * null, so an otherwise perfect suite was being discarded in full: four
   * valid cases thrown away over a JSON idiom. Accept null and normalise it to
   * absent, which is what it means.
   */
  body: z.union([z.string(), z.record(z.string(), z.unknown())])
    .nullish()
    .transform((v) => (v === null ? undefined : v)),
  assertions: z.array(assertionSchema).min(1).max(8),
  category: z.enum(['positive', 'negative', 'boundary']),
});

/**
 * The envelope the model must produce.
 *
 * `preprocess` accepts a BARE ARRAY as well as { cases: [...] }. Models emit the
 * array form regularly: it is a formatting slip, not an ambiguity of intent,
 * and rejecting it burned two full generation attempts before failing the run.
 * Coercing a shape whose meaning is unmistakable is not the same as inventing
 * data: nothing is fabricated, one wrapper is supplied.
 */
/** Hard ceiling on a single generation, to bound cost and execution time. */
export const MAX_CASES = 12;

export const generationSchema = z.preprocess(
  (value) => {
    const envelope = Array.isArray(value) ? { cases: value } : value;
    // TRUNCATE rather than reject. The ceiling exists to bound cost, not to
    // fail a run: a model that returns 15 cases when asked for 5 has been
    // over-eager, not wrong, and throwing the batch away helps nobody.
    if (Array.isArray(envelope?.cases) && envelope.cases.length > MAX_CASES) {
      return { ...envelope, cases: envelope.cases.slice(0, MAX_CASES) };
    }
    return envelope;
  },
  /**
   * The ENVELOPE is validated here; individual cases are NOT.
   *
   * This used to be z.array(generatedCaseSchema), which made the per-case
   * discard logic below unreachable: one malformed case failed the whole
   * object, so a generation with four perfect cases and one typo produced
   * nothing at all and burned both repair attempts. docs/01_PRD.md F2 requires
   * unusable cases to be "discarded and counted", which is only possible if the
   * good ones survive validation of the batch.
   */
  z.object({ cases: z.array(z.unknown()).min(1).max(MAX_CASES) }),
);

export const SYSTEM_PROMPT = `You are a senior QA engineer who writes precise, executable API tests.

Return ONLY a JSON object of the form { "cases": [ ... ] }. No prose, no markdown, no code fences.

Each case must have:
  name        short human-readable title
  intent      one sentence: what this verifies and why
  method      GET | POST | PUT | PATCH | DELETE | HEAD | OPTIONS
  path        "" to target the base URL itself (this is the common case: the base URL
              is already a complete endpoint), or "?a=1" to add a query string to it,
              or "/other/path" with a LEADING SLASH to target a different endpoint.
              Never repeat the base URL's own path here.
  headers     object of request headers (may be {})
  body        request body for write methods (omit for GET)
  category    positive | negative | boundary
  assertions  1-8 assertions from the list below

Assertion kinds, and their exact shapes:
  { "kind": "status",            "expected": 200 }
  { "kind": "responseTimeUnder", "ms": 2000 }
  { "kind": "jsonPathExists",    "path": "$.id" }
  { "kind": "jsonPathEquals",    "path": "$.role", "value": "user" }
  { "kind": "jsonPathType",      "path": "$.items", "type": "array" }
  { "kind": "headerPresent",     "name": "content-type" }
  { "kind": "headerEquals",      "name": "content-type", "value": "application/json" }
  { "kind": "bodyMatches",       "pattern": "^\\\\{" }

Every assertion may also carry a confidence, "high" or "low" (default "high"):
  { "kind": "status", "expected": 400, "confidence": "low" }
Mark an assertion "low" when you are INFERRING the contract rather than certain
of it: an error code you are not sure the endpoint validates, a field name you
are guessing at. Mark it "high", or just omit the flag, when the handler code,
the specification, or the endpoint's stated purpose makes the expectation
certain. A "low" assertion that turns out wrong is NOT counted as a failure, so
be honest: downgrade a genuine guess, never a claim you are sure of.

Rules:
  - Assert what a CORRECT endpoint should do. Never weaken an assertion to make
    it pass. Write the assertion you believe is right and set its confidence
    honestly, rather than dropping a useful check because you are unsure: a
    "low" check that misses costs nothing, and one that holds adds coverage.
  - Status codes: a normal successful GET returns 200 (a create returns 201). Do
    NOT assume an unsupported method returns 405: most frameworks, Express among
    them, return 404 for a method or route they do not handle, so expect 404
    unless a specification explicitly declares 405.
  - Authentication: if the endpoint is admin or privileged, or its purpose implies
    a credential is required, a request WITHOUT one should expect 401 or 403, never
    200. When you were given no credential, assert 401 for such a route.
  - Response body: assert only on fields whose names you actually know from the
    description or specification. NEVER invent field names. When unsure of the
    shape, assert the response is JSON (jsonPathType "$" is object or array) or
    that a named field exists (jsonPathExists), not an exact value you are guessing.
  - content-type: assert the media type only ("application/json"), not the charset.
  - A negative case must expect a failure status. Do not rewrite it to expect 200.
  - A boundary or malformed-input case should expect an error (400 or 422) only
    when the endpoint clearly validates that input. If you are not sure it
    validates, do not assert a specific error code for it.
  - jsonPath uses $.a.b and $.a[0] only.
  - Cover at least one positive, one negative and one boundary case.`;

/** Builds the user prompt, grounded in a spec operation when one is supplied. */
export function buildPrompt({
  url, method, description, count = 4, operation = null, categories = null, handlerSource = null,
}) {
  const lines = [
    `Base URL: ${url}`,
    `Primary method: ${method}`,
    `What this endpoint is for: ${description}`,
    '',
    `Generate exactly ${count} test cases.`,
  ];

  if (handlerSource) {
    // Contract-anchoring: the endpoint's real handler code. It is the ground
    // truth for the SHAPE of the contract (which status codes and fields exist,
    // what inputs are validated, which branches to cover), which is what a
    // one-line intent cannot convey. The expected BEHAVIOUR still comes from the
    // purpose above, so a genuine defect is caught rather than rubber-stamped.
    lines.push(
      '',
      'This is the endpoint\'s actual handler code:',
      '```',
      handlerSource,
      '```',
      'Read it to see the REAL status codes it returns, the fields it responds with, the',
      'inputs it validates, and the branches worth covering (auth checks, not-found, bad',
      'input). Target those cases precisely, and let the code set your confidence:',
      '  - Where the handler clearly validates an input, guards auth, or handles a missing',
      '    resource, assert the matching 4xx at HIGH confidence: a miss there is a real bug.',
      '  - Where the handler does NOT do those things, it will answer on its success path.',
      '    Do NOT assert a 4xx there at high confidence. Either assert the status the code',
      '    will actually return, or, to flag that it SHOULD be stricter, mark that 4xx',
      '    assertion "low" confidence, so the note stays visible without failing the run on',
      '    behaviour the code plainly shows.',
      '  - If the handler requires a credential you were not given, do not write a positive',
      '    case that expects success: the unauthenticated case (expecting 401 or 403) is the',
      '    one you can actually verify without a token.',
    );
  }

  if (categories?.length) {
    // Per-endpoint category selection (docs/10_AUTONOMOUS_PLATFORM.md §D): the
    // categories that make sense for THIS endpoint, not a fixed list for every
    // endpoint. An endpoint with no body has no malformed-body case to write.
    lines.push(
      '',
      'Prioritise these test categories, chosen for this endpoint:',
      ...categories.map((c) => `  - ${c.label}: ${c.hint}`),
    );
  }

  if (operation) {
    // Spec-grounded generation (docs/01_PRD.md F4). Assertions should reference
    // DECLARED response fields rather than fields the model imagined.
    lines.push(
      '',
      'This endpoint is described by an OpenAPI operation. Ground every assertion in it.',
      `Operation: ${operation.method} ${operation.path}`,
      operation.summary ? `Summary: ${operation.summary}` : '',
      operation.parameters?.length
        ? `Parameters: ${operation.parameters.map((p) => `${p.name} (${p.in}${p.required ? ', required' : ''})`).join(', ')}`
        : 'Parameters: none',
      operation.responses?.length
        ? `Declared responses: ${operation.responses.map((r) => `${r.status} ${r.description ?? ''}`.trim()).join(' | ')}`
        : '',
      operation.security?.length ? `Security schemes: ${operation.security.join(', ')}` : '',
      '',
      'Use the declared status codes. Assert on fields the specification actually declares.',
    );
  }

  return lines.filter(Boolean).join('\n');
}

/**
 * Joins a base URL and a model-supplied path.
 *
 * ── WHY THIS IS FIDDLIER THAN IT LOOKS ──────────────────────────────────────
 * The base can be either an API ROOT ("https://api.x/v1", where "users" should
 * append) or a COMPLETE ENDPOINT ("https://api.x/users/1", where appending
 * "users/1" produces the nonsense "/users/1/users/1"). Nothing in the string
 * distinguishes the two, so the prompt now tells the model exactly what to
 * return and this function handles the two cases it cannot get right by
 * resolution alone:
 *
 *   1. A QUERY-ONLY suffix appends to the base as-is. Previously "?a=1" became
 *      ".../users/1/?a=1": a trailing slash that 404s on many routers.
 *   2. A suffix that merely REPEATS the tail of the base path is the model
 *      restating the endpoint it was given, so the base is returned unchanged.
 *      This is an exact string comparison, not a guess.
 *
 * The evaluation harness is what surfaced both: baseline pass rates of 1/9 and
 * 5/21 against an app that was behaving perfectly.
 */
export function joinUrl(base, suffix) {
  if (!suffix) return base;

  // 1. Query- or fragment-only: append directly, no path segment involved.
  if (suffix.startsWith('?') || suffix.startsWith('#')) {
    try {
      const url = new URL(base);
      if (suffix.startsWith('?')) url.search = suffix;
      else url.hash = suffix;
      return url.toString();
    } catch {
      return base;
    }
  }

  try {
    const baseUrl = new URL(base);
    const [suffixPath, suffixQuery] = suffix.split('?');
    const wanted = suffixPath.startsWith('/') ? suffixPath : `/${suffixPath}`;

    // 2. The model restated the endpoint it was already given.
    if (baseUrl.pathname === wanted || baseUrl.pathname.endsWith(wanted)) {
      if (suffixQuery) baseUrl.search = suffixQuery;
      return baseUrl.toString();
    }

    return new URL(suffix, base.endsWith('/') ? base : `${base}/`).toString();
  } catch {
    return base;
  }
}

/**
 * Generate test cases. Pure: no network, no database.
 *
 * @returns {{ cases, discarded, discardReasons, tokens, provider, model, costUsd }}
 */
export async function generateCases({
  url, method = 'GET', description, count = 4, operation = null, categories = null,
  handlerSource = null, llm = generateJSON,
}) {
  const result = await llm({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt({ url, method, description, count, operation, categories, handlerSource }),
    schema: generationSchema,
    maxTokens: 2400,
  });

  // Per-case validation. Unusable cases are DISCARDED AND COUNTED, never
  // silently dropped and never allowed to sink the whole batch
  // (docs/01_PRD.md F2). If EVERY case is unusable, generateCases' caller
  // raises GEN_FAILED: a visible failure, not an empty success.
  const kept = [];
  const discardReasons = [];
  for (const c of result.data.cases) {
    const parsed = generatedCaseSchema.safeParse(c);
    if (!parsed.success) {
      discardReasons.push(parsed.error.issues[0]?.message ?? 'invalid case');
      continue;
    }
    kept.push({ ...parsed.data, url: joinUrl(url, parsed.data.path) });
  }

  return {
    cases: kept,
    discarded: result.data.cases.length - kept.length,
    discardReasons,
    provider: result.provider,
    model: result.model,
    tokens: { input: result.inputTokens, output: result.outputTokens },
    costUsd: result.costUsd,
    attempts: result.attempts,
    generationMs: result.durationMs,
  };
}

/**
 * Execute generated cases through the MCP tool layer.
 *
 * `runTool` is injected: the agent never imports the tool registry directly, so
 * it cannot accidentally acquire a path to the network, and tests can drive it
 * with a stub. Every invocation here produces an audit row.
 */
export async function executeCases({ cases, runTool, context = {} }) {
  const results = [];
  for (const testCase of cases) {
    const outcome = await runTool('run_test_case', {
      name: testCase.name,
      url: testCase.url,
      method: testCase.method,
      headers: testCase.headers,
      ...(testCase.body === undefined ? {} : { body: testCase.body }),
      assertions: testCase.assertions,
    }, context);

    results.push({ ...outcome, intent: testCase.intent, category: testCase.category });
  }
  return results;
}

/** Summary numbers for the run header. `discarded` is surfaced, never hidden. */
export function summarise(results, discarded = 0) {
  return {
    totalTests: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    errored: results.filter((r) => r.status === 'error').length,
    discarded,
    assertionsEvaluated: results.reduce((n, r) => n + (r.assertions?.length ?? 0), 0),
    // Low-confidence assertions that missed. These did not fail their case; the
    // count travels up so the report can note the guesses that did not hold.
    softFailed: results.reduce((n, r) => n + (r.softFailed ?? 0), 0),
  };
}

/**
 * The full agent: generate, then execute.
 *
 * Note what is NOT here: no axios, no fetch, no direct database access. The
 * agent orchestrates; the tools act.
 */
export async function runTestingAgent({
  url, method = 'GET', description, count = 4, operation = null, categories = null,
  handlerSource = null, runTool, context = {}, llm = generateJSON,
}) {
  const generated = await generateCases({
    url, method, description, count, operation, categories, handlerSource, llm,
  });

  if (generated.cases.length === 0) {
    // Every case was discarded. Fail visibly rather than returning an empty
    // "successful" run that a reader would mistake for a clean result.
    const err = new Error(
      `Test generation produced no usable cases (${generated.discarded} discarded: ` +
      `${generated.discardReasons.slice(0, 3).join('; ')})`,
    );
    err.code = 'GEN_FAILED';
    err.details = generated;
    throw err;
    }

  const results = await executeCases({ cases: generated.cases, runTool, context });

  return {
    summary: summarise(results, generated.discarded),
    functional: results,
    generation: {
      provider: generated.provider,
      model: generated.model,
      tokens: generated.tokens,
      costUsd: generated.costUsd,
      attempts: generated.attempts,
      generationMs: generated.generationMs,
      grounded: Boolean(operation),
    },
  };
}

// ── Grounded testing from a discovered endpoint (Phase 2) ────────────────────

/**
 * The test categories the agent can ask for, each with a one-line prompt hint.
 * docs/10_AUTONOMOUS_PLATFORM.md §3. selectCategories picks the subset that
 * makes sense for a given endpoint.
 */
export const TEST_CATEGORY = {
  VALID: { key: 'valid', label: 'Valid request', hint: 'a well-formed request that should succeed' },
  MALFORMED_PARAM: { key: 'malformed_param', label: 'Malformed parameter', hint: 'a path or query parameter of the wrong shape' },
  BOUNDARY: { key: 'boundary', label: 'Boundary value', hint: 'edge values such as 0, negative, very large, or empty' },
  WRONG_TYPE: { key: 'wrong_type', label: 'Wrong data type', hint: 'a string where a number is expected, and similar' },
  MISSING_BODY: { key: 'missing_body', label: 'Missing body', hint: 'no body on a write endpoint, expecting a client error' },
  MALFORMED_BODY: { key: 'malformed_body', label: 'Malformed body', hint: 'invalid JSON or the wrong fields on a write endpoint' },
  NOT_FOUND: { key: 'not_found', label: 'Unknown resource', hint: 'an id that does not exist, expecting 404' },
  UNAUTH: { key: 'unauthenticated', label: 'Unauthenticated access', hint: 'no credentials against a protected route, expecting 401 or 403' },
  SERVER_ERROR: { key: 'server_error', label: 'No unexpected 5xx', hint: 'a well-formed request must never answer 5xx' },
};

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** Path segments that signal a route needs authentication (not login/register). */
const PROTECTED_HINT = /\b(admin|account|profile|dashboard|settings|private|internal)\b/i;

/**
 * Chooses the categories worth testing for one endpoint. Deterministic: the
 * endpoint's method, its params and its path decide, so a GET with no params
 * gets a short list and a POST that looks protected gets body and auth cases.
 * A fixed list for every endpoint wastes generation on cases that cannot exist.
 */
export function selectCategories(endpoint, { intent = null } = {}) {
  const T = TEST_CATEGORY;
  const chosen = [T.VALID, T.SERVER_ERROR];
  const method = String(endpoint.method ?? 'GET').toUpperCase();
  const params = endpoint.params ?? [];
  const path = endpoint.path ?? '';

  if (params.length) {
    chosen.push(T.MALFORMED_PARAM, T.BOUNDARY);
    if (params.some((p) => /id$/i.test(p)) || /:id\b|\{id\}/i.test(path)) chosen.push(T.NOT_FOUND);
  }
  if (WRITE_METHODS.has(method)) chosen.push(T.MISSING_BODY, T.MALFORMED_BODY, T.WRONG_TYPE);
  if (PROTECTED_HINT.test(path) || /requires? (auth|login|a token)/i.test(String(intent ?? ''))) {
    chosen.push(T.UNAUTH);
  }

  const seen = new Set();
  return chosen.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}

/**
 * Maps a discovered endpoint (Phase 1 shape) onto the operation grounding shape
 * the prompt already understands. Static discovery knows the method, path and
 * path params; it does not know declared responses or security, so those are
 * empty until spec import or intent inference fills them.
 */
export function endpointToOperation(endpoint, { intent = null } = {}) {
  return {
    method: String(endpoint.method ?? 'GET').toUpperCase(),
    path: endpoint.path ?? '/',
    summary: intent,
    parameters: (endpoint.params ?? []).map((name) => ({ name, in: 'path', required: true })),
    responses: [],
    security: [],
  };
}

/**
 * Runs the Testing Agent against a DISCOVERED endpoint, with no user-typed URL
 * or description. `baseUrl` is the running app's root; the endpoint supplies the
 * path and params, and generation is grounded in them and in the chosen
 * categories. This is the autonomy step: the user provides the project, not the
 * tests. docs/10_AUTONOMOUS_PLATFORM.md §D, Phase 2.
 */
/**
 * Fills path params with a sample value so the generation base URL is a REAL,
 * reachable endpoint. `baseUrl` is the app root; the generation prompt tells the
 * model "the base URL IS the endpoint", so the base must actually be the
 * endpoint. Passing the bare root instead made every `path: ""` case hit `/`,
 * which 404s on any app without a root route, and it is exactly the bug that
 * made a healthy app's endpoints all fail their positive tests.
 */
export function sampleEndpointPath(operation) {
  return String(operation.path ?? '/')
    .replace(/:[A-Za-z0-9_]+/g, '1') // Express-style /users/:id -> /users/1
    .replace(/\{[A-Za-z0-9_]+\}/g, '1'); // OpenAPI-style /users/{id} -> /users/1
}

/**
 * Pulls just this endpoint's handler out of its source file, anchored on the
 * route's line and stopping at the next route definition (or a line cap). The
 * generator gets the real handler, not the whole file, so the prompt stays small
 * and focused on the contract this one endpoint actually implements.
 */
export function extractHandler(source, line, { maxLines = 55 } = {}) {
  if (!source) return '';
  const lines = String(source).split('\n');
  const anchor = Math.max(0, (Number(line) || 1) - 1);
  const routeRe = /\b(app|router|server)\.(get|post|put|patch|delete|options|head|all|use)\s*\(/;
  const out = [];
  for (let i = anchor; i < lines.length && out.length < maxLines; i += 1) {
    if (i > anchor && routeRe.test(lines[i])) break; // the next route: this handler ended
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

export async function runTestingAgentForEndpoint({
  endpoint, baseUrl, intent = null, source = null, count = 4, runTool, context = {}, llm = generateJSON,
}) {
  const operation = endpointToOperation(endpoint, { intent });
  const categories = selectCategories(endpoint, { intent });
  const paramNote = operation.parameters.length
    ? ` with path params ${operation.parameters.map((p) => p.name).join(', ')}`
    : '';
  const description = intent ?? `${operation.method} ${operation.path}${paramNote}`;

  const outcome = await runTestingAgent({
    url: joinUrl(baseUrl, sampleEndpointPath(operation)),
    method: operation.method, description, count,
    operation, categories,
    handlerSource: extractHandler(source, endpoint.line),
    runTool, context, llm,
  });
  return {
    ...outcome,
    endpoint: { method: operation.method, path: operation.path },
    categories: categories.map((c) => c.key),
  };
}

export default runTestingAgent;
