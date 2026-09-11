/**
 * dep_audit: known-vulnerable dependencies, via `npm audit --json`.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §E, Phase 3. Risk class local.process: it
 * spawns npm (no shell, workspace cwd, bounded by a timeout). npm audit needs a
 * lockfile and reaches the public registry; when it cannot run (no lockfile, no
 * npm, a timeout) the tool returns an informational note rather than failing the
 * whole assessment. The JSON parsing is a pure, tested function.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { parseNpmAudit } from '../analysis/depAudit.js';
import { requireWorkspace } from './fs_read.js';
import { findingSchema } from './_findingSchema.js';

const MAX_OUTPUT = 8 * 1024 * 1024;

export const inputSchema = z.object({
  timeoutMs: z.number().int().positive().max(120000).default(60000),
});

export const outputSchema = z.object({
  ran: z.boolean(),
  note: z.string().nullable(),
  findings: z.array(findingSchema),
  summary: z.object({
    total: z.number(), critical: z.number(), high: z.number(), moderate: z.number(), low: z.number(),
  }).nullable(),
});

/** Runs `npm audit --json` in the workspace and returns its stdout, or null. */
export function runNpmAudit(cwd, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };

    let child;
    try {
      child = spawn('npm', ['audit', '--json'], { cwd, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null); // npm not on PATH
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out = (out + d).slice(0, MAX_OUTPUT); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    // npm audit exits non-zero WHEN vulnerabilities exist, so the code is ignored;
    // what matters is whether stdout parsed as the audit JSON.
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

export default defineTool({
  name: 'dep_audit',
  title: 'Audit dependencies',
  description: 'Run npm audit against the project and report known-vulnerable dependencies with their severity and fix advice.',
  riskClass: RISK_CLASS.LOCAL_PROCESS,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const stdout = await runNpmAudit(jail.root, input.timeoutMs);
    if (!stdout) {
      return { ran: false, note: 'npm audit could not run (no npm, no lockfile, or it timed out).', findings: [], summary: null };
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { ran: false, note: 'npm audit produced output that could not be parsed as JSON.', findings: [], summary: null };
    }
    if (parsed?.error) {
      return { ran: false, note: `npm audit reported: ${parsed.error.summary ?? parsed.error.code ?? 'an error'}.`, findings: [], summary: null };
    }
    const { findings, summary } = parseNpmAudit(parsed);
    return { ran: true, note: null, findings, summary };
  },
});
