/**
 * config_scan: insecure configuration in app and container config.
 * docs/10_AUTONOMOUS_PLATFORM.md §E, Phase 3. Reads through the jail; the checks
 * are pure functions (analysis/configScan.js).
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { collectWorkspaceFiles, walkWorkspace, readTextInJail } from '../analysis/workspace.js';
import { scanAppConfig, scanCommittedEnv, scanDockerfile } from '../analysis/configScan.js';
import { requireWorkspace } from './fs_read.js';
import { findingSchema } from './_findingSchema.js';

const CODE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);

export const inputSchema = z.object({ maxFiles: z.number().int().positive().max(20000).default(5000) });
export const outputSchema = z.object({
  findings: z.array(findingSchema),
  stats: z.object({ filesScanned: z.number(), findingCount: z.number() }),
});

export default defineTool({
  name: 'config_scan',
  title: 'Configuration analysis',
  description: 'Scan app and container configuration for insecure defaults: permissive CORS, missing security headers, a committed .env, and Dockerfile issues.',
  riskClass: RISK_CLASS.LOCAL_FS_READ,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const { files } = collectWorkspaceFiles(jail, { maxFiles: input.maxFiles, exts: CODE_EXTS });

    // A full path listing (any extension) for file-presence checks.
    const { files: allPaths } = walkWorkspace(jail, { maxFiles: input.maxFiles, exts: null });

    const findings = [
      ...scanAppConfig(files),
      ...scanCommittedEnv(allPaths),
    ];
    for (const p of allPaths) {
      if (/(^|\/)Dockerfile$/.test(p)) findings.push(...scanDockerfile(p, readTextInJail(jail, p)));
    }
    return { findings, stats: { filesScanned: files.length, findingCount: findings.length } };
  },
});
