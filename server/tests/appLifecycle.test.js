/**
 * The process sandbox and the app_lifecycle tool.
 *
 * The sandbox is to a child process what the egress guard is to the network:
 * these tests prove it refuses a disallowed runner and a scrubbed environment,
 * and that start / status / stop drive a real app on loopback and leave nothing
 * running afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { getTool } from '../src/mcp/registry.js';
import {
  spawnSandboxed, childEnv, pickFreePort, killTree, ProcessError, DEFAULT_LIMITS,
} from '../src/mcp/procSandbox.js';

let workspace;
const ctx = () => ({ userId: null, sessionId: 'lifecycle', workspaceRoot: workspace });
const app_lifecycle = (input) => getTool('app_lifecycle').handler(input, ctx());

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
  workspace = mkdtempSync(path.join(tmpdir(), 'app-'));
  // A tiny server that binds the injected PORT on loopback and echoes it back.
  writeFileSync(path.join(workspace, 'server.js'), `
    const http = require('node:http');
    http.createServer((req, res) => res.end('ok ' + process.env.PORT))
      .listen(process.env.PORT, '127.0.0.1');
  `);
  // An app that crashes immediately, to prove readiness fails cleanly.
  writeFileSync(path.join(workspace, 'crash.js'), 'process.exit(1);\n');
});

afterAll(async () => {
  await app_lifecycle({ action: 'stop' }).catch(() => {});
  rmSync(workspace, { recursive: true, force: true });
  await disconnectTestDb();
});

describe('process sandbox', () => {
  it('refuses a runner that is not on the allowlist', () => {
    expect(() => spawnSandboxed({ runner: 'bash', args: ['-c', 'x'], cwd: workspace, port: 1 }))
      .toThrow(ProcessError);
  });

  it('refuses args that are not an array of strings', () => {
    expect(() => spawnSandboxed({ runner: 'node', args: 'server.js', cwd: workspace, port: 1 }))
      .toThrow(ProcessError);
  });

  it('scrubs the environment: no platform secrets reach the child', () => {
    const env = childEnv(3000);
    expect(env.PORT).toBe('3000');
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.MONGO_URI).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_ENV', 'PATH', 'PORT']);
  });

  it('caps the child heap through NODE_OPTIONS when a limit is given', () => {
    const env = childEnv(3000, { maxOldSpaceMb: 512 });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=512');
    // The cap is the only addition; the rest of the environment is untouched.
    expect(Object.keys(env).sort()).toEqual(['HOME', 'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'PORT']);
  });

  it('exposes a resource ceiling with a heap cap and a lifetime backstop', () => {
    expect(DEFAULT_LIMITS.maxOldSpaceMb).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxLifetimeMs).toBeGreaterThan(0);
    expect(DEFAULT_LIMITS.maxOutputBytes).toBeGreaterThan(0);
  });

  it('killTree is a no-op on a child that already exited, and never throws', () => {
    expect(killTree(null)).toBe(false);
    expect(killTree({ pid: undefined })).toBe(false);
    // A pid that cannot exist: the group signal fails, the direct-kill fallback
    // fails, and killTree reports false rather than throwing.
    expect(killTree({ pid: 2147483646, kill: () => { throw new Error('gone'); } })).toBe(false);
  });

  it('pickFreePort returns a usable port', async () => {
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe('app_lifecycle', () => {
  it('starts an app, reports it running, and stops it', async () => {
    const started = await app_lifecycle({ action: 'start', runner: 'node', file: 'server.js' });
    expect(started.running).toBe(true);
    expect(started.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // It really is listening on loopback.
    const reachable = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: started.port });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    expect(reachable).toBe(true);

    const status = await app_lifecycle({ action: 'status' });
    expect(status.running).toBe(true);
    expect(status.port).toBe(started.port);

    const stopped = await app_lifecycle({ action: 'stop' });
    expect(stopped.running).toBe(false);

    const after = await app_lifecycle({ action: 'status' });
    expect(after.running).toBe(false);
  }, 30000);

  it('fails cleanly when the app crashes before it is ready', async () => {
    await expect(
      app_lifecycle({ action: 'start', runner: 'node', file: 'crash.js', readyTimeoutMs: 4000 }),
    ).rejects.toThrow(/exited before it was ready/i);
    // Nothing left running.
    expect((await app_lifecycle({ action: 'status' })).running).toBe(false);
  }, 15000);

  it('refuses a node entry file that escapes the workspace', async () => {
    await expect(
      app_lifecycle({ action: 'start', runner: 'node', file: '../../../etc/hosts' }),
    ).rejects.toThrow();
    expect((await app_lifecycle({ action: 'status' })).running).toBe(false);
  });
});
