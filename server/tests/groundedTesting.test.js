/**
 * Grounded testing from a discovered endpoint (Phase 2).
 *
 * The autonomy step: the Testing Agent runs against an endpoint that discovery
 * found, with no user-typed URL or description. These tests check that the
 * categories are chosen per endpoint, that the endpoint grounds the prompt, and
 * that a full run executes with the LLM stubbed (so no provider is needed).
 */
import { describe, it, expect } from 'vitest';
import {
  selectCategories, endpointToOperation, runTestingAgentForEndpoint, extractHandler,
} from '../src/agents/testing.agent.js';

const SOURCE = `app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/admin/tasks', (req, res) => {
  const token = req.get('authorization')?.replace(/^Bearer\\s+/i, '');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({ tasks: listAll() });
});

app.get('/api/stats', (req, res) => res.json({ counts: {} }));`;

describe('extractHandler', () => {
  it('pulls just the handler at the given line, stopping at the next route', () => {
    const snippet = extractHandler(SOURCE, 3); // the /api/admin/tasks route
    expect(snippet).toContain("app.get('/api/admin/tasks'");
    expect(snippet).toContain('return res.status(401)');
    // It stops before the next route.
    expect(snippet).not.toContain('/api/stats');
  });

  it('returns empty for no source', () => {
    expect(extractHandler('', 3)).toBe('');
    expect(extractHandler(null, 3)).toBe('');
  });
});

const keys = (endpoint, opts) => selectCategories(endpoint, opts).map((c) => c.key).sort();

describe('selectCategories', () => {
  it('a plain GET with no params gets only the always-on categories', () => {
    expect(keys({ method: 'GET', path: '/health', params: [] }))
      .toEqual(['server_error', 'valid']);
  });

  it('an id-addressed GET gets malformed, boundary and not-found', () => {
    expect(keys({ method: 'GET', path: '/users/:id', params: ['id'] }))
      .toEqual(['boundary', 'malformed_param', 'not_found', 'server_error', 'valid']);
  });

  it('a write endpoint gets body categories', () => {
    const k = keys({ method: 'POST', path: '/login', params: [] });
    expect(k).toContain('missing_body');
    expect(k).toContain('malformed_body');
    expect(k).toContain('wrong_type');
  });

  it('does not add an auth case to a login endpoint (it is called without credentials)', () => {
    expect(keys({ method: 'POST', path: '/login', params: [] })).not.toContain('unauthenticated');
  });

  it('adds an auth case to a route that reads as protected', () => {
    expect(keys({ method: 'GET', path: '/admin/users', params: [] })).toContain('unauthenticated');
  });
});

describe('endpointToOperation', () => {
  it('maps path params to required path parameters', () => {
    const op = endpointToOperation({ method: 'get', path: '/users/:id', params: ['id'] });
    expect(op.method).toBe('GET');
    expect(op.parameters).toEqual([{ name: 'id', in: 'path', required: true }]);
  });

  it('carries inferred intent into the summary', () => {
    const op = endpointToOperation({ method: 'GET', path: '/x', params: [] }, { intent: 'returns a widget' });
    expect(op.summary).toBe('returns a widget');
  });
});

describe('runTestingAgentForEndpoint', () => {
  const goodCases = {
    cases: [
      {
        name: 'valid', intent: 'positive', method: 'GET', path: '/users/1', headers: {},
        category: 'positive', assertions: [{ kind: 'status', expected: 200 }],
      },
      {
        name: 'not found', intent: 'negative', method: 'GET', path: '/users/999999', headers: {},
        category: 'negative', assertions: [{ kind: 'status', expected: 404 }],
      },
      {
        name: 'boundary', intent: 'boundary', method: 'GET', path: '/users/abc', headers: {},
        category: 'boundary', assertions: [{ kind: 'status', expected: 400 }],
      },
    ],
  };

  function capturingLlm(capture) {
    return async ({ prompt, schema }) => {
      capture.prompt = prompt;
      return {
        data: schema.parse(goodCases), provider: 'stub', model: 'stub-1',
        inputTokens: 10, outputTokens: 20, costUsd: 0.0001, attempts: 1, repairStage: 'direct', durationMs: 1,
      };
    };
  }

  it('grounds the prompt in the endpoint and chosen categories, then executes', async () => {
    const capture = {};
    const out = await runTestingAgentForEndpoint({
      endpoint: { method: 'GET', path: '/users/:id', params: ['id'] },
      baseUrl: 'http://127.0.0.1:4001',
      llm: capturingLlm(capture),
      runTool: async () => ({ status: 'pass', assertions: [] }),
    });

    // The prompt was grounded in the real endpoint, not a user description.
    expect(capture.prompt).toContain('Operation: GET /users/:id');
    expect(capture.prompt).toContain('id (path, required)');
    expect(capture.prompt).toContain('Unknown resource'); // the not-found category label

    // The run executed and is labelled with the endpoint and its categories.
    expect(out.endpoint).toEqual({ method: 'GET', path: '/users/:id' });
    expect(out.categories).toContain('not_found');
    expect(out.functional).toHaveLength(3);
    expect(out.generation.grounded).toBe(true);
  });

  it('needs no user-supplied description (the endpoint is the input)', async () => {
    const capture = {};
    await runTestingAgentForEndpoint({
      endpoint: { method: 'POST', path: '/login', params: [] },
      baseUrl: 'http://127.0.0.1:4001',
      llm: capturingLlm(capture),
      runTool: async () => ({ status: 'pass', assertions: [] }),
    });
    expect(capture.prompt).toContain('POST /login');
    expect(capture.prompt).toContain('Missing body'); // a write-endpoint category
  });

  it('anchors generation in the endpoint handler source when it is given', async () => {
    const capture = {};
    await runTestingAgentForEndpoint({
      endpoint: { method: 'GET', path: '/api/admin/tasks', params: [], file: 'src/app.js', line: 3 },
      baseUrl: 'http://127.0.0.1:4001',
      source: SOURCE,
      llm: capturingLlm(capture),
      runTool: async () => ({ status: 'pass', assertions: [] }),
    });
    // The real handler (with its 401 branch) is in the prompt, so the model can
    // see the auth check rather than guessing a 200.
    expect(capture.prompt).toContain('actual handler code');
    expect(capture.prompt).toContain('return res.status(401)');
    // And it is the FOCUSED handler, not the whole file.
    expect(capture.prompt).not.toContain('/api/stats');
  });
});
