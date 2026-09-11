/**
 * Testing Agent: generation, repair, execution.
 *
 * The LLM is stubbed throughout: docs/02_TRD.md §11 says CI must never depend
 * on a provider being up. What is measured here is the pipeline itself: prompt
 * construction, repair, schema enforcement, discard accounting, and the
 * separation between proposing an assertion and judging it.
 *
 * Measuring a real model's structural validity is the evaluation harness's job
 * (docs/01_PRD.md F10), and is deliberately not faked here.
 */
import { describe, it, expect } from 'vitest';
import {
  generateCases, executeCases, runTestingAgent, summarise, buildPrompt, joinUrl,
  generationSchema, SYSTEM_PROMPT,
} from '../src/agents/testing.agent.js';
import { parseLooseJson, extractJson, unwrapArray, normaliseSyntax } from '../src/services/jsonRepair.js';
import { evaluateAssertions } from '../src/mcp/tools/run_test_case.js';
import { generateJSON, LLM_ERROR, estimateCostUsd, providerOrder } from '../src/services/llm.js';

/** A well-formed generation, as a good model would return it. */
const GOOD = {
  cases: [
    {
      name: 'Returns the user', intent: 'happy path', method: 'GET', path: 'users/1',
      headers: {}, category: 'positive',
      assertions: [{ kind: 'status', expected: 200 }, { kind: 'jsonPathExists', path: '$.id' }],
    },
    {
      name: 'Unknown user is 404', intent: 'negative', method: 'GET', path: 'users/99999',
      headers: {}, category: 'negative',
      assertions: [{ kind: 'status', expected: 404 }],
    },
    {
      name: 'Non-numeric id rejected', intent: 'boundary', method: 'GET', path: 'users/abc',
      headers: {}, category: 'boundary',
      assertions: [{ kind: 'status', expected: 400 }],
    },
  ],
};

/** Builds a stub llm() that returns whatever `text` a real provider might. */
function stubLlm(payload, extra = {}) {
  return async ({ schema }) => {
    const parsed = schema ? schema.safeParse(payload) : { success: true, data: payload };
    if (!parsed.success) {
      const err = new Error('schema mismatch');
      err.code = LLM_ERROR.SCHEMA_MISMATCH;
      throw err;
    }
    return {
      data: parsed.data, provider: 'stub', model: 'stub-1',
      inputTokens: 100, outputTokens: 200, costUsd: 0.0001,
      attempts: 1, repairStage: 'direct', durationMs: 5, ...extra,
    };
  };
}

// ── JSON repair ──────────────────────────────────────────────────────────────

describe('JSON repair pipeline', () => {
  it('parses clean JSON directly', () => {
    const r = parseLooseJson('{"a":1}');
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('direct');
  });

  it('strips code fences', () => {
    const r = parseLooseJson('```json\n{"a":1}\n```');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it('ignores prose either side', () => {
    const r = parseLooseJson('Sure! Here are your tests:\n{"a":1}\nHope that helps.');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it('repairs trailing commas, smart quotes and unquoted keys', () => {
    expect(parseLooseJson('{"a":1,}').ok).toBe(true);
    expect(parseLooseJson('{ name: "x" }').value).toEqual({ name: 'x' });
    expect(JSON.parse(normaliseSyntax('{“a”:1}'))).toEqual({ a: 1 });
  });

  it('does not end extraction on a bracket inside a string', () => {
    // lastIndexOf-style scanning gets this wrong; the depth walk does not.
    const r = parseLooseJson('{"pattern":"a}b","n":1}');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ pattern: 'a}b', n: 1 });
  });

  it('handles nested structures', () => {
    const src = '{"cases":[{"assertions":[{"kind":"status","expected":200}]}]}';
    expect(extractJson(`prose ${src} more prose`)).toBe(src);
  });

  it('reports unrecoverable output rather than guessing', () => {
    const r = parseLooseJson('I am afraid I cannot help with that.');
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('unrecoverable');
  });

  it('unwraps the common envelope mistakes', () => {
    expect(unwrapArray({ testCases: [1, 2] })).toEqual([1, 2]);
    expect(unwrapArray({ tests: [1] })).toEqual([1]);
    expect(unwrapArray([1])).toEqual([1]);
  });
});

describe('repair recovers realistic model output', () => {
  // 50 samples of the shapes models actually emit. This measures the REPAIR
  // PIPELINE's recovery rate, not a model's quality (the evaluation measures that).
  const body = JSON.stringify(GOOD);
  const SAMPLES = [
    body,
    `\`\`\`json\n${body}\n\`\`\``,
    `\`\`\`\n${body}\n\`\`\``,
    `Here you go:\n${body}`,
    `${body}\n\nLet me know if you need more.`,
    `  \n${body}\n  `,
    body.replace('}]}', '},]}'),
    `Sure!\n\`\`\`json\n${body}\n\`\`\`\nDone.`,
  ];

  it('recovers at least 95% of realistic wrappings', () => {
    const trials = Array.from({ length: 50 }, (_, i) => SAMPLES[i % SAMPLES.length]);
    const recovered = trials.filter((t) => {
      const p = parseLooseJson(t);
      return p.ok && generationSchema.safeParse(p.value).success;
    }).length;
    const rate = recovered / trials.length;
    expect(rate, `recovery rate ${(rate * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.95);
  });
});

// ── Prompt construction ──────────────────────────────────────────────────────

describe('prompt', () => {
  it('never instructs the model to weaken an assertion', () => {
    // Rewriting GET + expected 400 into expected 200 would edit the test until
    // it passes. The prompt forbids it explicitly.
    expect(SYSTEM_PROMPT).toMatch(/Never weaken an assertion/i);
    expect(SYSTEM_PROMPT).toMatch(/Do not rewrite it to expect 200/i);
  });

  it('includes the target and the intent', () => {
    const p = buildPrompt({ url: 'https://api.x/y', method: 'POST', description: 'creates a thing' });
    expect(p).toContain('https://api.x/y');
    expect(p).toContain('POST');
    expect(p).toContain('creates a thing');
  });

  it('grounds in a spec operation when one is supplied', () => {
    const p = buildPrompt({
      url: 'https://api.x', method: 'GET', description: 'd',
      operation: {
        method: 'GET', path: '/users/{id}', summary: 'Fetch a user',
        parameters: [{ name: 'id', in: 'path', required: true }],
        responses: [{ status: '200', description: 'The user' }, { status: '404', description: 'Not found' }],
        security: ['bearerAuth'],
      },
    });
    expect(p).toContain('/users/{id}');
    expect(p).toContain('id (path, required)');
    expect(p).toContain('404');
    expect(p).toContain('bearerAuth');
    expect(p).toMatch(/declared status codes/i);
  });

  it('says nothing about a spec when none is attached', () => {
    const p = buildPrompt({ url: 'https://api.x', method: 'GET', description: 'd' });
    expect(p).not.toMatch(/OpenAPI/i);
  });
});

describe('joinUrl', () => {
  it.each([
    // An API ROOT plus a path: append. This is the case that always worked.
    ['https://api.x', 'users/1', 'https://api.x/users/1'],
    ['https://api.x/', 'users/1', 'https://api.x/users/1'],
    ['https://api.x/v1', 'users?a=1', 'https://api.x/v1/users?a=1'],
    ['https://api.x', '', 'https://api.x'],
  ])('%s + %s -> %s', (base, suffix, expected) => {
    expect(joinUrl(base, suffix)).toBe(expected);
  });

  /**
   * REGRESSION: a base that is already a COMPLETE ENDPOINT.
   *
   * Every real target URL has a path, and the model routinely restates it or
   * asks for a query string. Both produced URLs that 404'd, so a generated
   * suite mostly failed against an application that was behaving perfectly.
   * The evaluation harness found this: baseline pass rates of 1/9 and 5/21
   * against the hardened fixture, which by construction is correct.
   */
  it.each([
    // The model restates the endpoint it was given.
    ['http://h/users/1', 'users/1', 'http://h/users/1'],
    ['http://h/api/users/1', 'api/users/1', 'http://h/api/users/1'],
    // Query-only: must not acquire a trailing slash before the '?'.
    ['http://h/users/1', '?verbose=1', 'http://h/users/1?verbose=1'],
    // A leading slash means a different endpoint entirely.
    ['http://h/users/1', '/users/99999', 'http://h/users/99999'],
    // Restated path carrying a query.
    ['http://h/items', 'items?ownerId=2', 'http://h/items?ownerId=2'],
  ])('endpoint base: %s + %s -> %s', (base, suffix, expected) => {
    expect(joinUrl(base, suffix)).toBe(expected);
  });

  it('never throws on a malformed suffix', () => {
    expect(joinUrl('https://api.x', 'http://[::bad')).toBe('https://api.x');
  });
});

// ── Generation ───────────────────────────────────────────────────────────────

describe('generateCases', () => {
  const base = { url: 'https://api.example.com', method: 'GET', description: 'user API' };

  /**
   * REGRESSION: one bad case must not sink the batch.
   *
   * generationSchema used to validate each case inside the envelope, which made
   * the discard-and-count path below it unreachable: four perfect cases plus one
   * typo produced NOTHING and burned both repair attempts. Found by the
   * evaluation harness, where it failed a whole run at the eighth of eight
   * suites.
   */
  it('keeps the usable cases and counts the rest', async () => {
    const good = {
      name: 'ok', intent: 'i', method: 'GET', path: '', headers: {},
      category: 'positive', assertions: [{ kind: 'status', expected: 200 }],
    };
    const r = await generateCases({ ...base, llm: stubLlm([good, { method: 'NOPE' }, good]) });
    expect(r.cases).toHaveLength(2);
    expect(r.discarded).toBe(1);
    expect(r.discardReasons).toHaveLength(1);
  });

  it('accepts a bare array, which models emit regularly', async () => {
    const good = {
      name: 'ok', intent: 'i', method: 'GET', path: '', headers: {},
      category: 'positive', assertions: [{ kind: 'status', expected: 200 }],
    };
    const arrayLlm = async ({ schema }) => ({
      data: schema.parse([good]), provider: 'stub', model: 'stub',
      inputTokens: 1, outputTokens: 1, costUsd: 0, attempts: 1, durationMs: 1,
    });
    const r = await generateCases({ ...base, llm: arrayLlm });
    expect(r.cases).toHaveLength(1);
  });

  it('treats a null body as absent: models write "body": null for GET', async () => {
    const withNullBody = {
      name: 'ok', intent: 'i', method: 'GET', path: '', headers: {}, body: null,
      category: 'positive', assertions: [{ kind: 'status', expected: 200 }],
    };
    const r = await generateCases({ ...base, llm: stubLlm([withNullBody]) });
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].body).toBeUndefined();
  });

  it('returns validated cases with absolute URLs', async () => {
    const r = await generateCases({ ...base, llm: stubLlm(GOOD) });
    expect(r.cases).toHaveLength(3);
    expect(r.cases[0].url).toBe('https://api.example.com/users/1');
    expect(r.discarded).toBe(0);
  });

  it('reports tokens and cost for the evaluation', async () => {
    const r = await generateCases({ ...base, llm: stubLlm(GOOD) });
    expect(r.tokens).toEqual({ input: 100, output: 200 });
    expect(r.costUsd).toBeCloseTo(0.0001);
  });

  it('covers positive, negative and boundary categories', async () => {
    const r = await generateCases({ ...base, llm: stubLlm(GOOD) });
    expect(new Set(r.cases.map((c) => c.category))).toEqual(
      new Set(['positive', 'negative', 'boundary']),
    );
  });

  it('marks a run as grounded only when a spec operation was used', async () => {
    const withSpec = await runTestingAgent({
      ...base, llm: stubLlm(GOOD), runTool: async () => ({ status: 'pass', assertions: [] }),
      operation: { method: 'GET', path: '/x', responses: [] },
    });
    expect(withSpec.generation.grounded).toBe(true);

    const without = await runTestingAgent({
      ...base, llm: stubLlm(GOOD), runTool: async () => ({ status: 'pass', assertions: [] }),
    });
    expect(without.generation.grounded).toBe(false);
  });
});

describe('failure is visible, never a fabricated fallback', () => {
  it('THROWS when the model cannot produce usable output', async () => {
    const failing = async () => {
      const err = new Error('Generation failed after trying groq');
      err.code = LLM_ERROR.INVALID_JSON;
      throw err;
    };
    await expect(generateCases({
      url: 'https://api.x', description: 'd', llm: failing,
    })).rejects.toThrow(/Generation failed/);
  });

  it('THROWS rather than returning an empty successful run', async () => {
    // Hardcoded cases returned here would make a broken run look clean.
    const allInvalid = stubLlm({ cases: [] });
    await expect(runTestingAgent({
      url: 'https://api.x', description: 'd', llm: allInvalid, runTool: async () => ({}),
    })).rejects.toThrow();
  });

  it('defines no fallback cases in executable code', async () => {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(
      new URL('../src/agents/testing.agent.js', import.meta.url), 'utf8',
    );
    // Comments may describe the rule. What must not exist is a fallback
    // literal in executable code, so comments are stripped before matching.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/Fallback Valid Request|Fallback Invalid|Fallback Edge/i);
    expect(code).not.toMatch(/const\s+FALLBACK|FALLBACK_CASES|SAFE FALLBACK/i);
  });
});

// ── Execution through the tool layer ─────────────────────────────────────────

describe('executeCases', () => {
  it('routes every case through the injected tool, never directly', async () => {
    const calls = [];
    const runTool = async (name, input) => {
      calls.push({ name, input });
      return { name: input.name, status: 'pass', httpStatus: 200, responseTimeMs: 12, assertions: [] };
    };
    const { cases } = await generateCases({
      url: 'https://api.example.com', description: 'd', llm: stubLlm(GOOD),
    });
    const results = await executeCases({ cases, runTool });

    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.name === 'run_test_case')).toBe(true);
    expect(results[0].intent).toBe('happy path');
  });

  it('passes assertions through unchanged: the agent does not edit them', async () => {
    let seen = null;
    const runTool = async (_n, input) => { seen = input.assertions; return { status: 'pass', assertions: [] }; };
    const { cases } = await generateCases({
      url: 'https://api.example.com', description: 'd', llm: stubLlm(GOOD),
    });
    await executeCases({ cases: [cases[1]], runTool });
    // The negative case expected 404 and must still expect 404.
    expect(seen).toEqual([{ kind: 'status', expected: 404 }]);
  });
});

describe('summarise', () => {
  it('counts outcomes and surfaces discarded', () => {
    const s = summarise([
      { status: 'pass', assertions: [1, 2] },
      { status: 'fail', assertions: [1] },
      { status: 'error', assertions: [] },
    ], 2);
    expect(s).toEqual({
      totalTests: 3, passed: 1, failed: 1, errored: 1, discarded: 2, assertionsEvaluated: 3,
    });
  });
});

// ── The separation that makes results trustworthy ────────────────────────────

describe('the model proposes assertions; it never judges them', () => {
  it('a wrong expectation FAILS: the pipeline does not quietly correct it', () => {
    // Rewriting GET + 400 into 200 would make the case pass. Here the
    // assertion stands and the result is an honest failure.
    const results = evaluateAssertions(
      [{ kind: 'status', expected: 400 }],
      { status: 200, headers: {}, body: '{}', responseTimeMs: 10 },
    );
    expect(results[0].pass).toBe(false);
    expect(results[0].expected).toBe('400');
    expect(results[0].actual).toBe('200');
  });

  it('evaluation is deterministic: same response, same verdict', () => {
    const response = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"id":1}', responseTimeMs: 5 };
    const assertions = [
      { kind: 'status', expected: 200 },
      { kind: 'jsonPathEquals', path: '$.id', value: 1 },
      { kind: 'headerEquals', name: 'content-type', value: 'application/json' },
    ];
    const a = evaluateAssertions(assertions, response);
    const b = evaluateAssertions(assertions, response);
    expect(a).toEqual(b);
    expect(a.every((r) => r.pass)).toBe(true);
  });
});

// ── Provider abstraction ─────────────────────────────────────────────────────

describe('LLM abstraction', () => {
  it('reports no provider rather than inventing output', async () => {
    await expect(generateJSON({ system: 's', prompt: 'p', providers: [] }))
      .rejects.toMatchObject({ code: LLM_ERROR.NO_PROVIDER });
  });

  it('prices a known model', () => {
    // 1M in + 1M out on Nova Lite = 0.06 + 0.24
    expect(estimateCostUsd('apac.amazon.nova-lite-v1:0', 1e6, 1e6)).toBeCloseTo(0.30, 5);
    expect(estimateCostUsd('unknown-model', 1000, 1000)).toBeNull();
  });

  it('skips unconfigured providers in the order', () => {
    // Neither key is set under test (tests/setup.js deletes them).
    expect(providerOrder({ primary: 'groq', fallback: 'bedrock' })).toEqual([]);
  });

  it('Pollinations is gone from the tree', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/services/llm.js', import.meta.url), 'utf8');
    // Mentioned in a comment explaining the removal, never as an endpoint.
    expect(src).not.toMatch(/text\.pollinations\.ai/);
  });
});
