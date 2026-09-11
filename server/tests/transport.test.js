/**
 * MCP transports.
 *
 * The stdio test speaks real JSON-RPC to a real child process: the same
 * handshake Claude Desktop performs. That is the demo in docs/03_App_Flow.md
 * Part E step 8, so it is worth proving it works rather than assuming.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { registerAllTools, EXPECTED_TOOLS } from '../src/mcp/tools/index.js';
import { sessionCount, closeAllSessions } from '../src/mcp/transport.js';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';

const STDIO = path.resolve(import.meta.dirname, '../src/mcp/stdio.js');

/**
 * Speaks newline-delimited JSON-RPC to the stdio server and collects replies.
 * Resolves once `wanted` responses have arrived or the timeout expires.
 */
function talkToStdioServer(messages, { wanted = 1, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STDIO], {
      // No MONGO_URI: an MCP client must be able to list tools with no database.
      env: { ...process.env, NODE_ENV: 'test', MONGO_URI: '', LOG_LEVEL: 'silent' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses = [];
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`stdio server timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);

    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { responses.push(JSON.parse(line)); } catch { /* partial frame */ }
      }
      if (responses.length >= wanted) {
        clearTimeout(timer);
        child.kill();
        resolve({ responses, stderr });
      }
    });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });

    // Give the server a moment to register tools and connect the transport.
    setTimeout(() => {
      for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    }, 1500);
  });
}

const INITIALISE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'agentiq-test-client', version: '1.0.0' },
  },
};

describe('stdio transport', () => {
  it('completes the MCP handshake', async () => {
    const { responses } = await talkToStdioServer([INITIALISE], { wanted: 1 });
    const init = responses.find((r) => r.id === 1);
    expect(init, JSON.stringify(responses)).toBeTruthy();
    expect(init.result.serverInfo.name).toBe('agentiq');
    expect(init.result.capabilities).toHaveProperty('tools');
  }, 30_000);

  it('lists every tool to an external client', async () => {
    const { responses } = await talkToStdioServer(
      [
        INITIALISE,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      ],
      { wanted: 2 },
    );
    const list = responses.find((r) => r.id === 2);
    expect(list, JSON.stringify(responses)).toBeTruthy();
    const names = list.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  }, 30_000);

  it('writes nothing but JSON-RPC to stdout: logs must go to stderr', async () => {
    // A single stray console.log corrupts the protocol stream and the client
    // disconnects with a parse error. This is the most common way to break a
    // stdio MCP server, so it is asserted rather than assumed.
    const { responses, stderr } = await talkToStdioServer([INITIALISE], { wanted: 1 });
    expect(responses.every((r) => r.jsonrpc === '2.0')).toBe(true);
    expect(stderr).toMatch(/tools registered/);
  }, 30_000);
});

describe('streamable-HTTP transport', () => {
  const app = createApp({ logging: false });

  it('requires authentication', async () => {
    await registerAllTools();
    const res = await request(app).post('/api/mcp').send(INITIALISE);
    expect(res.status).toBe(401);
  });

  it('does not shadow the concrete /api/mcp/* routes', async () => {
    // The catch-all is declared last on purpose; if it were first it would
    // swallow /tools, /audit and /grants.
    const res = await request(app).get('/api/mcp/tools');
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(EXPECTED_TOOLS.length);
  });
});

/**
 * A REAL MCP SESSION OVER HTTP.
 *
 * Checking only "returns 401" and "does not shadow the sibling routes" would
 * leave the claim that a remote MCP client can drive AGENTIQ's tools over HTTP
 * unexercised. These tests perform the same initialise -> tools/list handshake
 * a real client performs, over the authenticated endpoint.
 *
 * (stdio.js reads as 0% in the coverage table and is NOT untested: the tests
 * above drive it as a spawned child process, which v8 coverage cannot see into.
 * It is excluded in vitest.config.js rather than left looking neglected.)
 */
describe('streamable-HTTP transport: a real session', () => {
  const app = createApp({ logging: false });
  let token;

  /** The Accept header the SDK requires; it answers JSON or SSE per request. */
  const ACCEPT = 'application/json, text/event-stream';

  beforeAll(async () => {
    await connectTestDb();
    await registerAllTools();
    const res = await request(app).post('/api/auth/register').send({
      displayName: 'MCP Client', email: 'mcp@example.com',
      password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
    });
    token = res.body.data.token;
  });

  afterAll(async () => {
    await closeAllSessions();
    await disconnectTestDb();
  });

  /** Bodies come back as JSON or as an SSE frame; accept either. */
  const parseRpc = (res) => {
    if (res.body && Object.keys(res.body).length) return res.body;
    const line = String(res.text ?? '').split('\n').find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  };

  const post = (body, sessionId) => {
    const r = request(app).post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', ACCEPT)
      .set('Content-Type', 'application/json');
    if (sessionId) r.set('mcp-session-id', sessionId);
    return r.send(body);
  };

  it('completes an initialise handshake and issues a session id', async () => {
    const before = sessionCount();
    const res = await post(INITIALISE);

    expect(res.status).toBe(200);
    const sessionId = res.headers['mcp-session-id'];
    expect(sessionId).toBeTruthy();
    expect(sessionCount()).toBe(before + 1);

    const rpc = parseRpc(res);
    expect(rpc?.result?.serverInfo?.name).toBe('agentiq');
  });

  it('lists every tool to a client over HTTP', async () => {
    const init = await post(INITIALISE);
    const sessionId = init.headers['mcp-session-id'];

    // The SDK requires the initialized notification before normal requests.
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);

    const res = await post(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId,
    );
    expect(res.status).toBe(200);

    const names = (parseRpc(res)?.result?.tools ?? []).map((t) => t.name);
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect(names).toEqual(expect.arrayContaining(EXPECTED_TOOLS));
  });

  it('refuses an unknown session id rather than silently opening a new one', async () => {
    // Silently creating a session would look like success while losing the
    // client's context: a much harder failure to diagnose than a 404.
    const res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MCP_SESSION_NOT_FOUND');
  });

  it('refuses a non-POST that carries no session', async () => {
    const res = await request(app).get('/api/mcp')
      .set('Authorization', `Bearer ${token}`).set('Accept', ACCEPT);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MCP_SESSION_REQUIRED');
  });

  /**
   * REGRESSION: two clients at once.
   *
   * The SDK binds an McpServer to one transport, so connecting a module
   * singleton for every session makes the second concurrent client receive a
   * 500. Two browser tabs, or Claude Desktop alongside the web UI, and one of
   * them breaks. A suite that only ever opens one session cannot catch that.
   */
  it('serves two concurrent clients without either breaking', async () => {
    const a = await post(INITIALISE);
    const sidA = a.headers['mcp-session-id'];
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sidA);
    expect((await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sidA)).status)
      .toBe(200);

    const b = await post(INITIALISE);
    expect(b.status).toBe(200);
    const sidB = b.headers['mcp-session-id'];
    expect(sidB).not.toBe(sidA);
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sidB);

    // Neither session may disturb the other.
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, sidA)).status)
      .toBe(200);
    expect((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }, sidB)).status)
      .toBe(200);
  });

  it('closeAllSessions empties the registry', async () => {
    await post(INITIALISE);
    expect(sessionCount()).toBeGreaterThan(0);
    await closeAllSessions();
    expect(sessionCount()).toBe(0);
  });
});
