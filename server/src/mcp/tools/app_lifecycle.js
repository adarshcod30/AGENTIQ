/**
 * app_lifecycle: start, health-check and stop the project's app on loopback.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §E, Phase 2. This is what removes the
 * user-supplied URL: the platform starts the app itself and derives the base
 * URL, so grounded testing can run against a project with nothing typed.
 *
 * Everything sensitive is in the process sandbox (mcp/procSandbox.js): no shell,
 * an allowlisted runner, the workspace as the working directory, a scrubbed
 * environment, and a loopback-only readiness check. The command is not free
 * text from the LLM: the runner is an enum and the script is a single token, so
 * there is nothing to inject.
 *
 * A module-level registry holds the running process per workspace, so `start`,
 * `status` and `stop` across separate tool calls refer to the same app. The
 * children are killed when the server exits, so a crashed run leaves no orphan.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { requireWorkspace } from './fs_read.js';
import {
  spawnSandboxed, pickFreePort, waitForPort, stopProcess, ProcessError, RUNNERS,
} from '../procSandbox.js';

/** workspaceRoot -> { child, port, baseUrl, runner, args, startedAt }. */
const running = new Map();

const SCRIPT_TOKEN = /^[a-zA-Z0-9:._-]+$/;
const STDERR_CAP = 4000;

export const inputSchema = z.object({
  action: z.enum(['start', 'status', 'stop']),
  runner: z.enum([...RUNNERS]).default('npm'),
  /** For a package-manager runner: the script name (npm run <script>). */
  script: z.string().regex(SCRIPT_TOKEN, { error: 'script must be a simple name' }).optional(),
  /** For the `node` runner: a workspace-relative entry file. */
  file: z.string().optional(),
  /** Fixed port for an app that ignores PORT; otherwise a free port is chosen. */
  port: z.number().int().positive().max(65535).optional(),
  readyTimeoutMs: z.number().int().positive().max(120000).default(20000),
});

export const outputSchema = z.object({
  action: z.string(),
  running: z.boolean(),
  port: z.number().nullable(),
  baseUrl: z.string().nullable(),
  pid: z.number().nullable(),
  message: z.string(),
});

const isAlive = (child) => child && child.exitCode === null && child.signalCode === null;

function statusFor(root, action = 'status') {
  const entry = running.get(root);
  if (!entry || !isAlive(entry.child)) {
    running.delete(root);
    return { action, running: false, port: null, baseUrl: null, pid: null, message: 'not running' };
  }
  return {
    action, running: true, port: entry.port, baseUrl: entry.baseUrl,
    pid: entry.child.pid, message: `running on ${entry.baseUrl}`,
  };
}

/** Builds the runner argument array. No shell, so nothing is interpolated. */
function buildArgs(input, jail) {
  if (input.runner === 'node') {
    if (!input.file) throw new ProcessError('The node runner needs a file', 'BAD_ARGS');
    return [jail.resolve(input.file)]; // jail throws on escape
  }
  const script = input.script ?? 'start';
  if (!SCRIPT_TOKEN.test(script)) throw new ProcessError('Invalid script name', 'BAD_ARGS');
  return ['run', script];
}

async function start(input, jail) {
  const root = jail.root;
  const existing = statusFor(root, 'start');
  if (existing.running) return { ...existing, message: `already ${existing.message}` };

  const port = input.port ?? await pickFreePort();
  const args = buildArgs(input, jail);
  const child = spawnSandboxed({ runner: input.runner, args, cwd: root, port });

  let stderr = '';
  child.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-STDERR_CAP); });

  // Race readiness against an early crash: whichever happens first wins.
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 'signal')));
  try {
    await Promise.race([
      waitForPort(port, { timeoutMs: input.readyTimeoutMs }),
      exited.then((code) => { throw new ProcessError(`App exited before it was ready (code ${code}). ${stderr.trim()}`, 'APP_CRASHED'); }),
    ]);
  } catch (err) {
    await stopProcess(child);
    throw err;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  running.set(root, { child, port, baseUrl, runner: input.runner, args, startedAt: Date.now() });
  return { action: 'start', running: true, port, baseUrl, pid: child.pid, message: `started on ${baseUrl}` };
}

async function stop(root) {
  const entry = running.get(root);
  if (!entry) return { action: 'stop', running: false, port: null, baseUrl: null, pid: null, message: 'nothing was running' };
  await stopProcess(entry.child);
  running.delete(root);
  return { action: 'stop', running: false, port: null, baseUrl: null, pid: null, message: 'stopped' };
}

/** Kill every child when the server process goes away, so nothing is orphaned. */
function killAll() {
  for (const { child } of running.values()) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  running.clear();
}
process.once('exit', killAll);
process.once('SIGTERM', () => { killAll(); });
process.once('SIGINT', () => { killAll(); });

export default defineTool({
  name: 'app_lifecycle',
  title: 'Run the project locally',
  description:
    'Start, health-check or stop the project under assessment as a local process on loopback, so '
    + 'the platform can test it without a user-supplied URL. Sandboxed: no shell, an allowlisted '
    + 'runner, the workspace as the working directory, and a scrubbed environment.',
  riskClass: RISK_CLASS.LOCAL_PROCESS,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    if (input.action === 'status') return statusFor(jail.root);
    if (input.action === 'stop') return stop(jail.root);
    return start(input, jail);
  },
});

/** For tests and shutdown paths that need to force-clear the registry. */
export { running as _runningProcesses, killAll as _killAll };
