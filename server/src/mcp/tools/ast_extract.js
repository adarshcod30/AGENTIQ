/**
 * ast_extract: parse one source file and return its structure.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §E. Pure compute (local.compute): it takes the
 * file CONTENT, already read by fs_read, and returns the routes, mounts and
 * imports the parser found. Keeping the parse separate from the read means the
 * read is audited as local.fs.read and the parse as local.compute, each on its
 * own terms, and the same analysis powers discover_routes.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { analyzeSource } from '../analysis/routes.js';

export const inputSchema = z.object({
  content: z.string(),
  filename: z.string().default('unknown'),
});

export const outputSchema = z.object({
  routers: z.array(z.string()),
  routes: z.array(z.object({
    method: z.string(),
    path: z.string(),
    params: z.array(z.string()),
    handlerCount: z.number(),
    via: z.string().nullable(),
    line: z.number().nullable(),
  })),
  mounts: z.array(z.object({
    prefix: z.string(),
    targets: z.array(z.object({ var: z.string().nullable(), import: z.string().nullable() })),
    line: z.number().nullable(),
  })),
  imports: z.record(z.string(), z.string()),
  parseError: z.string().nullable(),
});

export default defineTool({
  name: 'ast_extract',
  title: 'Extract structure from source',
  description:
    'Parse one JavaScript or TypeScript source file and return the Express routes, mounts and '
    + 'imports it declares. Pure analysis: no file is read and no network is touched.',
  riskClass: RISK_CLASS.LOCAL_COMPUTE,
  inputSchema,
  outputSchema,
  async handler(input) {
    return analyzeSource(input.content, { filename: input.filename });
  },
});
