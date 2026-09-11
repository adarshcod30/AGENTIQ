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

/**
 * The resource ceiling for a sandboxed child. These are backstops against a
 * runaway or abusive process, not tuning knobs for a healthy one: an assessment
 * that tests a couple of dozen endpoints finishes far inside them.
 *
 *   - maxOldSpaceMb caps the V8 heap. It is passed through NODE_OPTIONS, so it
 *     applies to `node` directly and to the `node` that npm/pnpm/yarn spawn
 *     underneath, since NODE_OPTIONS is inherited.
 *   - maxLifetimeMs is a hard wall-clock backstop. A child still alive after it
 *     is force-killed with its whole process group, so a stuck dev server cannot
 *     outlive the assessment that started it.
 *   - maxOutputBytes bounds what we keep from each of stdout and stderr, so a
 *     chatty child cannot grow the parent's memory without limit.
 */
export const DEFAULT_LIMITS = {
  maxOldSpaceMb: 512,
  maxLifetimeMs: 30 * 60 * 1000,
  maxOutputBytes: 256 * 1024,
};

export class ProcessError extends Error {
  constructor(message, code = 'PROCESS_ERROR') {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
  }
}

/**
 * A minimal environment for the child: never the platform's own secrets.
 * A heap cap is added only when asked for, so `childEnv(port)` on its own stays
 * the exact four-key scrubbed environment the sandbox has always produced.
 *
 * `extraEnv` is the opt-in runtime environment a user supplies for THEIR OWN app
 * (a database URL, a JWT secret) so a real app can start. It is layered UNDER the
 * controlled variables: the user can add what their app needs, but cannot
 * override PORT, PATH, HOME or NODE_ENV, so AGENTIQ still decides where the app
 * listens. It never carries AGENTIQ's own secrets: only what the user passed in.
 */
export function childEnv(port, { maxOldSpaceMb, extraEnv } = {}) {
  const env = {
    ...(extraEnv && typeof extraEnv === 'object' ? extraEnv : {}),
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    PORT: String(port),
    NODE_ENV: 'development',
  };
  if (maxOldSpaceMb) env.NODE_OPTIONS = `--max-old-space-size=${maxOldSpaceMb}`;
  return env;
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
 *
 * The child is spawned DETACHED so it leads its own process group. That is what
 * makes the whole tree reapable: `npm start` forks a `node`, and killing npm
 * alone would leave that node listening. Killing the group (killTree) takes them
 * both. A wall-clock backstop force-kills the group if the child outlives
 * `limits.maxLifetimeMs`; the timer is unref'd and cleared on exit, so it never
 * keeps the parent alive and never fires for a child that stops on its own.
 */
export function spawnSandboxed({ runner, args, cwd, port, limits = {}, env: extraEnv }) {
  if (!RUNNERS.has(runner)) {
    throw new ProcessError(`Runner not allowed: ${runner}`, 'RUNNER_NOT_ALLOWED');
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new ProcessError('args must be an array of strings', 'BAD_ARGS');
  }
  const l = { ...DEFAULT_LIMITS, ...limits };
  const child = spawn(runner, args, {
    cwd,
    env: childEnv(port, { maxOldSpaceMb: l.maxOldSpaceMb, extraEnv }),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  if (l.maxLifetimeMs > 0 && child.pid) {
    const timer = setTimeout(() => killTree(child, 'SIGKILL'), l.maxLifetimeMs);
    timer.unref?.();
    child.once('exit', () => clearTimeout(timer));
  }
  return child;
}

/**
 * Kills a sandboxed child and everything it spawned. The child is a group leader
 * (spawnSandboxed sets detached), so the negative-pid signal reaches the whole
 * group. If the group is already gone, or the platform has no process groups, it
 * falls back to signalling the direct child.
 */
export function killTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try { child.kill(signal); return true; } catch { return false; }
  }
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

/** Stops a child and its group: SIGTERM, then SIGKILL after a grace period. */
export function stopProcess(child, { graceMs = 3000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve(false);
    let done = false;
    const finish = (killed) => { if (!done) { done = true; resolve(killed); } };
    child.once('exit', () => finish(true));
    killTree(child, 'SIGTERM');
    setTimeout(() => {
      if (!done) {
        killTree(child, 'SIGKILL');
        finish(true);
      }
    }, graceMs);
  });
}
