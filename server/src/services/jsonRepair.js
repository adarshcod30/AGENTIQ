/**
 * JSON normalisation for LLM output.
 *
 * Models wrap JSON in code fences, add prose before it, emit trailing commas
 * and use smart quotes (docs/01_PRD.md F2). Recovering from that is worth doing
 * rather than discarding an otherwise-valid generation.
 *
 * WHAT THIS MUST NEVER DO
 * Change an assertion. Turning `GET` + `expected 400` into `expected 200` is
 * not normalisation, it is editing the test until it passes; paired with
 * status-code-only assertions, it makes a 100% pass rate close to tautological.
 *
 * Repair the SHAPE of the output. Never the MEANING of the assertion.
 */

/** Strips ```json fences and any prose either side of the JSON body. */
export function stripFences(text) {
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  return s;
}

/** Extracts the outermost JSON array or object, ignoring surrounding prose. */
export function extractJson(text) {
  const s = stripFences(text);

  // Prefer whichever structure starts first.
  const firstArray = s.indexOf('[');
  const firstObject = s.indexOf('{');
  if (firstArray === -1 && firstObject === -1) return null;

  const open = firstArray === -1 ? '{'
    : firstObject === -1 ? '['
      : firstArray < firstObject ? '[' : '{';
  const close = open === '[' ? ']' : '}';
  const start = open === '[' ? firstArray : firstObject;

  // Walk the string tracking depth so a bracket inside a string literal does
  // not end the scan early. lastIndexOf would break on nested structures.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Cosmetic fixes that do not change meaning. */
export function normaliseSyntax(json) {
  return json
    // Smart quotes -> straight quotes.
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // Trailing commas before a closing bracket.
    .replace(/,\s*([\]}])/g, '$1')
    // Unquoted keys: { name: ... } -> { "name": ... }
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
}

/**
 * Best-effort parse. Returns { ok, value, stage } so a caller can report HOW
 * the output was recovered, or that it could not be.
 */
export function parseLooseJson(text) {
  if (text === null || text === undefined) return { ok: false, value: null, stage: 'empty' };

  // 1. Already valid.
  try { return { ok: true, value: JSON.parse(String(text)), stage: 'direct' }; } catch { /* next */ }

  // 2. Fenced or surrounded by prose.
  const extracted = extractJson(text);
  if (extracted) {
    try { return { ok: true, value: JSON.parse(extracted), stage: 'extracted' }; } catch { /* next */ }

    // 3. Cosmetic syntax repair.
    try {
      return { ok: true, value: JSON.parse(normaliseSyntax(extracted)), stage: 'repaired' };
    } catch { /* fall through */ }
  }

  return { ok: false, value: null, stage: 'unrecoverable' };
}

/**
 * Coerces the common shape mistakes a model makes around the ENVELOPE, without
 * touching any field the model chose.
 *
 * Models often return { testCases: [...] } or { tests: [...] } when asked for a
 * bare array. Unwrapping that is a shape fix. Changing an expected status code
 * would not be.
 */
export function unwrapArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['testCases', 'tests', 'cases', 'items', 'results', 'data']) {
      if (Array.isArray(value[key])) return value[key];
    }
    // A single object where an array of one was expected.
    if (Object.keys(value).length > 0) return [value];
  }
  return [];
}
