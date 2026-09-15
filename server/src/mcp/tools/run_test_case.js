/**
 * run_test_case: execute one test case and evaluate its assertions.
 *
 * docs/02_TRD.md §6. The critical property:
 *
 *   THE LLM PROPOSES ASSERTIONS; IT NEVER JUDGES WHETHER ONE PASSED.
 *
 * Evaluation here is deterministic and reproducible. If the model also decided
 * pass/fail, a run would be an opinion rather than a measurement, and every
 * number in the evaluation would be worthless.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';

/**
 * Per-assertion confidence, shared by every assertion kind.
 *
 * The generator sets "low" on an assertion it INFERRED rather than knows: a
 * specific error code it is not sure the endpoint validates, a field name it is
 * guessing at. A failed "low" assertion does NOT fail the case, because a guess
 * that did not hold is not evidence the app is wrong. "high", which is the
 * default and the meaning of an omitted flag, is a claim the endpoint must meet,
 * so a failed "high" assertion is a real failure. The handler below is where
 * this distinction is applied.
 */
const confidence = { confidence: z.enum(['high', 'low']).default('high') };

/** The contract the LLM must emit (docs/02_TRD.md §6). */
export const assertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), expected: z.number().int(), ...confidence }),
  z.object({ kind: z.literal('responseTimeUnder'), ms: z.number().int().positive(), ...confidence }),
  z.object({ kind: z.literal('jsonPathExists'), path: z.string(), ...confidence }),
  z.object({ kind: z.literal('jsonPathEquals'), path: z.string(), value: z.unknown(), ...confidence }),
  z.object({
    kind: z.literal('jsonPathType'),
    path: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'object', 'array', 'null']),
    ...confidence,
  }),
  z.object({ kind: z.literal('headerPresent'), name: z.string(), ...confidence }),
  z.object({ kind: z.literal('headerEquals'), name: z.string(), value: z.string(), ...confidence }),
  z.object({ kind: z.literal('bodyMatches'), pattern: z.string().max(200), ...confidence }),
]);

export const inputSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  assertions: z.array(assertionSchema).min(1),
});

export const outputSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail', 'error']),
  httpStatus: z.number().nullable(),
  responseTimeMs: z.number(),
  assertions: z.array(z.object({
    kind: z.string(),
    expected: z.string(),
    actual: z.string(),
    pass: z.boolean(),
    confidence: z.enum(['high', 'low']).default('high'),
  })),
  // How many LOW-confidence assertions did not match. These did not fail the
  // case (see the handler), but the count is surfaced so a report can say "N
  // guesses did not hold" honestly, rather than hiding them entirely.
  softFailed: z.number().int().default(0),
  error: z.string().nullable(),
});

// ── JSONPath (a deliberately small subset) ───────────────────────────────────

/**
 * Supports $.a.b, $.a[0], $['a b']. Not a full JSONPath implementation, and
 * that is intentional: a general engine is a large dependency and an evaluation
 * surface we would then have to trust. Everything the assertion contract needs
 * is here.
 */
export function readJsonPath(obj, path) {
  if (typeof path !== 'string' || !path.startsWith('$')) return { found: false, value: undefined };
  const tokens = path
    .slice(1)
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\['([^']+)'\]/g, '.$1')
    .replace(/\["([^"]+)"\]/g, '.$1')
    .split('.')
    .filter(Boolean);

  let cur = obj;
  for (const token of tokens) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return { found: false, value: undefined };
    }
    if (!(token in cur)) return { found: false, value: undefined };
    cur = cur[token];
  }
  return { found: true, value: cur };
}

/** JSON's type names, with array and null distinguished from object. */
export function typeOfValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ── ReDoS protection for bodyMatches ─────────────────────────────────────────

/**
 * The LLM supplies this pattern, so it is untrusted input compiled as code.
 * docs/02_TRD.md §6: cap the length, reject nested quantifiers, time-box it.
 *
 * Nested quantifiers like (a+)+ are the classic catastrophic-backtracking shape;
 * refusing them outright is cheaper and more predictable than trying to detect
 * pathological behaviour at match time.
 */
export const NESTED_QUANTIFIER = /(\([^)]*[+*][^)]*\)|\[[^\]]*\][^)]*)[+*]\s*[+*]?|\([^)]*[+*]\)[+*]/;

export function compileSafeRegex(pattern) {
  if (pattern.length > 200) {
    throw Object.assign(new Error('bodyMatches pattern exceeds 200 characters'), {
      code: 'UNSAFE_PATTERN',
    });
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw Object.assign(
      new Error('bodyMatches pattern contains nested quantifiers, which risk catastrophic backtracking'),
      { code: 'UNSAFE_PATTERN' },
    );
  }
  return new RegExp(pattern);
}

// ── The evaluator ────────────────────────────────────────────────────────────

const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v));

/**
 * Status codes a generated test may reasonably guess between. When the model
 * asks for one and the endpoint answers another IN THE SAME CLASS, that is a
 * defensible reading of the contract, not a defect: 400 vs 404 for a bad or
 * missing id, 401 vs 403 for an auth rejection. Both are a correct client
 * error, so the assertion passes.
 *
 * The success family (200/201/204) is deliberately absent: there the exact code
 * often IS the contract, and softening it would hide a real "a create answered
 * 200, not 201" observation. Equivalence only ever holds WITHIN a class, so a
 * 4xx guess can never mask a 2xx or 5xx actual, which is where the real signal
 * (missing auth, an unhandled crash) lives.
 */
export const STATUS_EQUIVALENCE = [
  new Set([400, 404, 422]),
  new Set([401, 403]),
];

export function statusMatches(expected, actual) {
  if (expected === actual) return true;
  return STATUS_EQUIVALENCE.some((cls) => cls.has(expected) && cls.has(actual));
}

/**
 * Deterministic. Given the same response, always the same verdict.
 * Exported so tests can exercise it without any network.
 */
export function evaluateAssertions(assertions, response) {
  const { status, headers = {}, body = '', responseTimeMs = 0 } = response;

  let json;
  let jsonOk = false;
  try {
    json = JSON.parse(body);
    jsonOk = true;
  } catch {
    jsonOk = false;
  }

  const lowerHeaders = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );

  return assertions.map((a) => {
    // Carry the assertion's confidence onto its result. The switch decides the
    // pass/fail; the handler reads confidence to decide whether a failure is a
    // real one or a guess that did not hold.
    const result = (() => {
      switch (a.kind) {
      case 'status': {
        // 400 vs 404, 401 vs 403: a defensible contract guess passes (see
        // STATUS_EQUIVALENCE). An exact miss outside those classes still fails.
        const pass = statusMatches(a.expected, status);
        const softened = pass && status !== a.expected;
        return {
          kind: a.kind,
          expected: String(a.expected),
          actual: softened ? `${status} (accepted: equivalent to ${a.expected})` : String(status),
          pass,
        };
      }

      case 'responseTimeUnder':
        return {
          kind: a.kind, expected: `< ${a.ms}ms`, actual: `${responseTimeMs}ms`,
          pass: responseTimeMs < a.ms,
        };

      case 'jsonPathExists': {
        if (!jsonOk) {
          return { kind: a.kind, expected: a.path, actual: 'response was not JSON', pass: false };
        }
        const { found } = readJsonPath(json, a.path);
        return {
          kind: a.kind, expected: a.path, actual: found ? 'present' : 'not present', pass: found,
        };
      }

      case 'jsonPathEquals': {
        if (!jsonOk) {
          return { kind: a.kind, expected: show(a.value), actual: 'response was not JSON', pass: false };
        }
        const { found, value } = readJsonPath(json, a.path);
        return {
          kind: a.kind,
          expected: `${a.path} = ${show(a.value)}`,
          actual: found ? show(value) : 'not present',
          pass: found && JSON.stringify(value) === JSON.stringify(a.value),
        };
      }

      case 'jsonPathType': {
        if (!jsonOk) {
          return { kind: a.kind, expected: a.type, actual: 'response was not JSON', pass: false };
        }
        const { found, value } = readJsonPath(json, a.path);
        const actual = found ? typeOfValue(value) : 'not present';
        return {
          kind: a.kind, expected: `${a.path} is ${a.type}`, actual, pass: found && actual === a.type,
        };
      }

      case 'headerPresent': {
        const present = a.name.toLowerCase() in lowerHeaders;
        return {
          kind: a.kind, expected: a.name, actual: present ? 'present' : 'absent', pass: present,
        };
      }

      case 'headerEquals': {
        const actual = lowerHeaders[a.name.toLowerCase()];
        // Compare case-insensitively, and treat header PARAMETERS as optional:
        // a header like `content-type` carries `; charset=utf-8`, so an assertion
        // that names the media type alone (`application/json`) must still match.
        // Exact string comparison here failed a correct JSON response on every
        // endpoint, which is a false negative, not a defect in the target.
        const av = String(actual ?? '').toLowerCase().trim();
        const ev = String(a.value ?? '').toLowerCase().trim();
        const essence = (s) => s.split(';')[0].trim();
        const pass = actual !== undefined
          && (av === ev || essence(av) === essence(ev));
        return {
          kind: a.kind,
          expected: `${a.name}: ${a.value}`,
          actual: actual === undefined ? 'absent' : String(actual),
          pass,
        };
      }

      case 'bodyMatches': {
        try {
          const re = compileSafeRegex(a.pattern);
          // Time-box: a pattern that survives the static checks could still be
          // slow on a 5MB body, so cap what we match against.
          const sample = body.slice(0, 100_000);
          const matched = re.test(sample);
          return {
            kind: a.kind, expected: `/${a.pattern}/`,
            actual: matched ? 'matched' : 'no match', pass: matched,
          };
        } catch (err) {
          return {
            kind: a.kind, expected: `/${a.pattern}/`,
            actual: `rejected: ${err.message}`, pass: false,
          };
        }
      }

      /* c8 ignore next 2 */
      default:
        return { kind: 'unknown', expected: '', actual: '', pass: false };
      }
    })();
    return { ...result, confidence: a.confidence ?? 'high' };
  });
}

export default defineTool({
  name: 'run_test_case',
  title: 'Run test case',
  description:
    'Execute a test case against a user-nominated host and evaluate its assertions ' +
    'deterministically. The model proposes assertions; this tool decides pass or fail.',
  riskClass: RISK_CLASS.NETWORK_READ,
  inputSchema,
  outputSchema,
  async handler(input) {
    let res;
    try {
      res = await fetchGuarded(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
      });
    } catch (err) {
      // A failed request is a failed test with a named reason, never a crash
      // (docs/03_App_Flow.md Part D).
      return {
        name: input.name,
        status: 'error',
        httpStatus: null,
        responseTimeMs: 0,
        assertions: input.assertions.map((a) => ({
          kind: a.kind, expected: '', actual: err.code ?? err.message, pass: false,
          confidence: a.confidence ?? 'high',
        })),
        softFailed: 0,
        error: err.message,
      };
    }

    const results = evaluateAssertions(input.assertions, {
      status: res.status,
      headers: res.headers,
      body: res.body,
      responseTimeMs: res.durationMs,
    });

    // A case FAILS only if a HIGH-confidence assertion failed. A low-confidence
    // assertion that missed is a guess that did not hold, not a defect: it is
    // counted in softFailed and does not sink the case.
    const hardFailed = results.some((r) => !r.pass && r.confidence !== 'low');
    const softFailed = results.filter((r) => !r.pass && r.confidence === 'low').length;

    return {
      name: input.name,
      status: hardFailed ? 'fail' : 'pass',
      httpStatus: res.status,
      responseTimeMs: res.durationMs,
      assertions: results,
      softFailed,
      error: null,
    };
  },
});
