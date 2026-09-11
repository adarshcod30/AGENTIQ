/**
 * The process sandbox: bounded, shell-free spawning of a project's own app.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §G. This is to a child process what the egress
 * guard is to the network and the fs jail is to files. Every constraint here
 * exists to make "start the user's app" safe to do automatically:
 *
 *   - NO SHELL. Commands are spawned with an argument array, never a string, so
 *     there is no shell for an injected value to break out of.
 *   - RUNNER ALLOWLIST. The executable is one of a small set (npm, node, and the
 *     other package managers), never an arbitrary path the caller chose.
 *   - CWD PINNED to the workspace.
 *   - SCRUBBED ENV. The child gets PATH, HOME, PORT and NODE_ENV, and nothing
 *     else. AGENTIQ's own secrets (JWT_SECRET, MONGO_URI, provider keys) are
 *     never handed to the project being assessed.
 *   - LOOPBACK ONLY. Readiness is a TCP connect to 127.0.0.1, so nothing here
 *     reaches off the machine.
 *
 * In local mode the code being run is the user's own, so this is equivalent to
 * them running `npm start` themselves. Running UNTRUSTED code (the SaaS case)
 * needs container isolation on top of this, which docs/10 §I calls out.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

/** The only executables the sandbox will launch. */
export const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'node', 'npx']);

export class ProcessError extends Error {
  constructor(message, code = 'PROCESS_ERROR') {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
  }
}

/** A minimal environment for the child: never the platform's own secrets. */
export function childEnv(port) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    PORT: String(port),
    NODE_ENV: 'development',
  };
}

/** Asks the OS for a free TCP port by binding to 0 and reading it back. */
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawns a sandboxed child. `runner` must be in the allowlist and `args` an
 * array of strings; `cwd` is the workspace root. No shell, ever.
 */
export function spawnSandboxed({ runner, args, cwd, port }) {
  if (!RUNNERS.has(runner)) {
    throw new ProcessError(`Runner not allowed: ${runner}`, 'RUNNER_NOT_ALLOWED');
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new ProcessError('args must be an array of strings', 'BAD_ARGS');
  }
  return spawn(runner, args, {
    cwd,
    env: childEnv(port),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Resolves once 127.0.0.1:port accepts a TCP connection, or rejects on timeout. */
export function waitForPort(port, { host = '127.0.0.1', timeoutMs = 20000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.setTimeout(Math.min(intervalMs * 4, 2000));
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      const retry = () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new ProcessError(`Timed out waiting for the app on port ${port}`, 'READY_TIMEOUT'));
        } else {
          setTimeout(attempt, intervalMs);
        }
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    attempt();
  });
}

/** Stops a child: SIGTERM, then SIGKILL after a grace period. */
export function stopProcess(child, { graceMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(false);
    let done = false;
    const finish = (killed) => { if (!done) { done = true; resolve(killed); } };
    child.once('exit', () => finish(true));
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
      if (!done) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(true);
      }
    }, graceMs);
  });
}
