/**
 * secret_scan: find hardcoded credentials in the workspace.
 * docs/10_AUTONOMOUS_PLATFORM.md §E, Phase 3. Reads through the jail; the
 * detection is a pure function (analysis/secretScan.js) so it can be tested
 * directly. Matched secrets are masked in the evidence.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { collectWorkspaceFiles, SOURCE_EXTS } from '../analysis/workspace.js';
import { scanSecrets } from '../analysis/secretScan.js';
import { requireWorkspace } from './fs_read.js';
import { findingSchema } from './_findingSchema.js';

const EXTS = new Set([...SOURCE_EXTS, '.env', '.txt', '.sh', '.pem', '.key', '.config']);

/**
 * Secret-bearing files whose basename has no usable extension. path.extname()
 * returns '' for a dot-led name, so `.env`, `.env.production` and `id_rsa` slip
 * past an extension filter: exactly the files most likely to hold a real
 * credential. These are matched by name instead.
 *
 * `.env.example` / `.env.sample` match here too, on purpose: they are walked,
 * then scanContentForSecrets skips them, so a real `.env` sitting next to a
 * committed example is still read rather than mistaken for the placeholder.
 */
const SECRET_BASENAMES = new Set(['.npmrc', '.pgpass', '.netrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
export function isSecretFile(basename) {
  return /^\.env(\..+)?$/.test(basename) || SECRET_BASENAMES.has(basename);
}

export const inputSchema = z.object({ maxFiles: z.number().int().positive().max(20000).default(5000) });
export const outputSchema = z.object({
  findings: z.array(findingSchema),
  stats: z.object({ filesScanned: z.number(), findingCount: z.number() }),
});

export default defineTool({
  name: 'secret_scan',
  title: 'Scan for hardcoded secrets',
  description: 'Scan the project workspace for hardcoded credentials (provider keys, private keys, inline passwords). Matched secrets are masked.',
  riskClass: RISK_CLASS.LOCAL_FS_READ,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const { files } = collectWorkspaceFiles(jail, { maxFiles: input.maxFiles, exts: EXTS, matchName: isSecretFile });
    const findings = scanSecrets(files);
    return { findings, stats: { filesScanned: files.length, findingCount: findings.length } };
  },
});
