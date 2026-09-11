/**
 * End-to-end: the Testing Agent against the real fixture apps.
 *
 * The LLM is stubbed (CI must not depend on a provider), but everything after
 * generation is real: the cases go through the run_test_case MCP tool, which
 * performs actual HTTP requests through the egress guard, evaluates assertions
 * deterministically, and writes audit rows.
 *
 * This is the first test where the full chain runs together:
 *   agent -> MCP tool -> permission gate -> egress guard -> fixture -> assertions -> audit
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { runTestingAgent } from '../src/agents/testing.agent.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { getTool } from '../src/mcp/registry.js';
import { grantStore, RISK_CLASS } from '../src/mcp/permissions.js';
import { AuditEvent, OUTCOME } from '../src/models/AuditEvent.js';
import { env } from '../src/config/env.js';
import { app as vulnerableApp } from '../../fixtures/vulnerable-api/server.js';
import { app as hardenedApp } from '../../fixtures/hardened-api/server.js';

const CTX = { userId: null, sessionId: 'e2e', runId: 'run-e2e' };
let vulnerableUrl;
let hardenedUrl;
let servers = [];

/** Starts a fixture app on an ephemeral loopback port. */
function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();

  const v = await listen(vulnerableApp);
  const h = await listen(hardenedApp);
  servers = [v.s, h.s];
  vulnerableUrl = v.url;
  hardenedUrl = h.url;

  // The fixtures are on loopback, which the egress guard blocks by default.
  // This is exactly what ALLOW_PRIVATE_TARGETS exists for, and the env schema
  // refuses it outright when NODE_ENV=production.
  env.ALLOW_PRIVATE_TARGETS = true;
});

afterAll(async () => {
  env.ALLOW_PRIVATE_TARGETS = false;
  for (const s of servers) s.close();
  await disconnectTestDb();
});

beforeEach(async () => {
  await AuditEvent.collection.deleteMany({});
  grantStore.clear();
});

/** Grants network.read for a host and returns a runTool bound to the registry. */
function toolRunner(url) {
  grantStore.grant({
    userId: CTX.userId, sessionId: CTX.sessionId,
    riskClass: RISK_CLASS.NETWORK_READ, host: new URL(url).host,
  });
  return (name, input, context) => getTool(name).handler(input, { ...CTX, ...context });
}

/** A stub model that writes cases against the fixture contract. */
const stubLlm = (cases) => async ({ schema }) => {
  const data = schema.parse({ cases });
  return {
    data, provider: 'stub', model: 'stub-1',
    inputTokens: 120, outputTokens: 240, costUsd: 0.0002,
    attempts: 1, repairStage: 'direct', durationMs: 3,
  };
};

const CONTRACT_CASES = [
  {
    name: 'Fetch user 1', intent: 'happy path', method: 'GET', path: 'users/1',
    headers: {}, category: 'positive',
    assertions: [
      { kind: 'status', expected: 200 },
      { kind: 'jsonPathEquals', path: '$.username', value: 'alice' },
      { kind: 'jsonPathType', path: '$.id', type: 'number' },
      { kind: 'headerPresent', name: 'content-type' },
    ],
  },
  {
    name: 'Unknown user is 404', intent: 'negative', method: 'GET', path: 'users/99999',
    headers: {}, category: 'negative',
    assertions: [{ kind: 'status', expected: 404 }],
  },
  {
    name: 'Response is fast', intent: 'boundary', method: 'GET', path: 'health',
    headers: {}, category: 'boundary',
    assertions: [
      { kind: 'status', expected: 200 },
      { kind: 'responseTimeUnder', ms: 3000 },
    ],
  },
];

describe('agent -> MCP tool -> fixture, end to end', () => {
  it('executes real requests and evaluates every assertion', async () => {
    const result = await runTestingAgent({
      url: hardenedUrl, method: 'GET', description: 'fixture user API',
      llm: stubLlm(CONTRACT_CASES), runTool: toolRunner(hardenedUrl), context: CTX,
    });

    expect(result.summary.totalTests).toBe(3);
    expect(result.summary.passed).toBe(3);
    expect(result.summary.discarded).toBe(0);
    // 4 + 1 + 2 assertions across the three cases.
    expect(result.summary.assertionsEvaluated).toBe(7);
  });

  it('reports expected vs actual PER ASSERTION, not per case', async () => {
    const result = await runTestingAgent({
      url: hardenedUrl, description: 'fixture', llm: stubLlm([CONTRACT_CASES[0]]),
      runTool: toolRunner(hardenedUrl), context: CTX,
    });
    const assertions = result.functional[0].assertions;
    expect(assertions).toHaveLength(4);
    for (const a of assertions) {
      expect(a).toHaveProperty('kind');
      expect(a).toHaveProperty('expected');
      expect(a).toHaveProperty('actual');
      expect(a).toHaveProperty('pass');
    }
  });

  it('a genuinely wrong expectation FAILS, nothing rewrites it to pass', async () => {
    const wrong = [{
      ...CONTRACT_CASES[0],
      name: 'Deliberately wrong', assertions: [{ kind: 'status', expected: 418 }],
    }];
    const result = await runTestingAgent({
      url: hardenedUrl, description: 'fixture', llm: stubLlm(wrong),
      runTool: toolRunner(hardenedUrl), context: CTX,
    });
    expect(result.summary.failed).toBe(1);
    expect(result.functional[0].assertions[0]).toMatchObject({
      expected: '418', actual: '200', pass: false,
    });
  });

  it('detects the contract difference between the two fixtures', async () => {
    // /users/abc: hardened returns 400, vulnerable leaks a 500 with the SQL.
    const probe = [{
      name: 'Non-numeric id', intent: 'boundary', method: 'GET', path: 'users/abc',
      headers: {}, category: 'boundary',
      assertions: [{ kind: 'status', expected: 400 }],
    }];

    const hard = await runTestingAgent({
      url: hardenedUrl, description: 'fixture', llm: stubLlm(probe),
      runTool: toolRunner(hardenedUrl), context: CTX,
    });
    const vuln = await runTestingAgent({
      url: vulnerableUrl, description: 'fixture', llm: stubLlm(probe),
      runTool: toolRunner(vulnerableUrl), context: CTX,
    });

    expect(hard.summary.passed).toBe(1);
    expect(vuln.summary.failed).toBe(1); // 500, not 400
  });

  it('writes one audit row per tool call', async () => {
    await runTestingAgent({
      url: hardenedUrl, description: 'fixture', llm: stubLlm(CONTRACT_CASES),
      runTool: toolRunner(hardenedUrl), context: CTX,
    });
    const rows = await AuditEvent.find({ tool: 'run_test_case' }).lean();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.outcome === OUTCOME.OK)).toBe(true);
    expect(rows.every((r) => r.runId === 'run-e2e')).toBe(true);
  });

  it('an ungranted host is refused before any packet leaves', async () => {
    grantStore.clear(); // no grant at all
    const runTool = (name, input, context) => getTool(name).handler(input, { ...CTX, ...context });

    await expect(runTestingAgent({
      url: hardenedUrl, description: 'fixture', llm: stubLlm([CONTRACT_CASES[0]]),
      runTool, context: CTX,
    })).rejects.toThrow(/approve/i);

    const rows = await AuditEvent.find({ tool: 'run_test_case' }).lean();
    expect(rows[0].outcome).toBe(OUTCOME.DENIED);
  });

  it('a network failure becomes a failed test, not a crash', async () => {
    // Nothing is listening on this port.
    const dead = 'http://127.0.0.1:1';
    const result = await runTestingAgent({
      url: dead, description: 'unreachable',
      llm: stubLlm([{ ...CONTRACT_CASES[0], path: '' }]),
      runTool: toolRunner(dead), context: CTX,
    });
    expect(result.summary.errored).toBe(1);
    expect(result.functional[0].error).toBeTruthy();
  });
});
