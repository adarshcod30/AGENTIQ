/**
 * sast_scan: static source analysis for risky patterns.
 * docs/10_AUTONOMOUS_PLATFORM.md §E, Phase 3. Reads through the jail; the
 * ruleset is a pure function (analysis/sastScan.js). Semgrep integration is a
 * documented follow-up; the built-in patterns are the fallback that runs
 * everywhere with no extra install.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { collectWorkspaceFiles } from '../analysis/workspace.js';
import { scanSource } from '../analysis/sastScan.js';
import { requireWorkspace } from './fs_read.js';
import { findingSchema } from './_findingSchema.js';

const CODE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

export const inputSchema = z.object({ maxFiles: z.number().int().positive().max(20000).default(5000) });
export const outputSchema = z.object({
  findings: z.array(findingSchema),
  stats: z.object({ filesScanned: z.number(), findingCount: z.number() }),
});

export default defineTool({
  name: 'sast_scan',
  title: 'Static source analysis',
  description: 'Scan the workspace source for risky patterns: injection sinks, command execution, eval, path traversal and weak crypto. Findings are leads to verify, not proofs.',
  riskClass: RISK_CLASS.LOCAL_FS_READ,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const { files } = collectWorkspaceFiles(jail, { maxFiles: input.maxFiles, exts: CODE_EXTS });
    const findings = scanSource(files);
    return { findings, stats: { filesScanned: files.length, findingCount: findings.length } };
  },
});
