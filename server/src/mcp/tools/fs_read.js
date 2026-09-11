/**
 * fs_read: read one file from inside the project workspace.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §E. The workspace root is server-controlled
 * context, never tool input: the caller (the discovery service) supplies
 * `workspaceRoot`, and the LLM supplies only a relative `path`. The jail decides
 * whether that path is allowed, which is why the risk class is auto-granted.
 */
import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { createJail } from '../fsJail.js';

const DEFAULT_MAX_BYTES = 512 * 1024;

export const inputSchema = z.object({
  path: z.string().min(1, { error: 'A workspace-relative path is required' }),
  maxBytes: z.number().int().positive().max(4 * 1024 * 1024).optional(),
});

export const outputSchema = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
});

export function requireWorkspace(context) {
  if (!context?.workspaceRoot) {
    throw Object.assign(
      new Error('fs_read requires a project workspace. Open it against a Project.'),
      { code: 'NO_WORKSPACE' },
    );
  }
  return createJail(context.workspaceRoot);
}

export default defineTool({
  name: 'fs_read',
  title: 'Read a workspace file',
  description:
    'Read one file from inside the project workspace under assessment. The path is relative to '
    + 'the workspace root and cannot escape it.',
  riskClass: RISK_CLASS.LOCAL_FS_READ,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const abs = jail.resolve(input.path); // throws FsJailError on escape
    const cap = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const size = statSync(abs).size;
    const raw = readFileSync(abs, 'utf8');
    const content = raw.length > cap ? raw.slice(0, cap) : raw;
    return {
      path: input.path,
      content,
      bytes: size,
      truncated: raw.length > cap,
    };
  },
});
