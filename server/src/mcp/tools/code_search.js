/**
 * code_search: find lines matching a query across the project workspace.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §E. Pure and in-process: it walks the workspace
 * through the jail and matches lines itself, rather than shelling out to
 * ripgrep. That keeps this tool inside local.fs.read with no process sandbox,
 * which is deferred to a later phase. It is bounded on files, results and line
 * length so no input can make it run unbounded.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { walkWorkspace, readTextInJail } from '../analysis/workspace.js';
import { requireWorkspace } from './fs_read.js';

const MAX_LINE = 400;

export const inputSchema = z.object({
  query: z.string().min(1, { error: 'A search query is required' }),
  isRegex: z.boolean().default(false),
  maxResults: z.number().int().positive().max(1000).default(200),
  maxFiles: z.number().int().positive().max(20000).default(5000),
});

export const outputSchema = z.object({
  query: z.string(),
  hits: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
  filesScanned: z.number(),
  truncated: z.boolean(),
});

/** Builds a matcher. A bad regex falls back to a literal search rather than throwing. */
export function buildMatcher(query, isRegex) {
  if (!isRegex) {
    const needle = query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  let re;
  try {
    re = new RegExp(query);
  } catch {
    const needle = query.toLowerCase();
    return (line) => line.toLowerCase().includes(needle);
  }
  return (line) => re.test(line);
}

export default defineTool({
  name: 'code_search',
  title: 'Search the workspace',
  description:
    'Search the project workspace for lines matching a literal string or a regular expression. '
    + 'Skips dependencies and build output. Returns file, line number and the matching text.',
  riskClass: RISK_CLASS.LOCAL_FS_READ,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const match = buildMatcher(input.query, input.isRegex);
    const { files } = walkWorkspace(jail, { maxFiles: input.maxFiles });

    const hits = [];
    let filesScanned = 0;
    let truncated = false;

    for (const rel of files) {
      const text = readTextInJail(jail, rel);
      if (text === null) continue;
      filesScanned += 1;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (match(lines[i])) {
          hits.push({ path: rel, line: i + 1, text: lines[i].slice(0, MAX_LINE).trim() });
          if (hits.length >= input.maxResults) { truncated = true; break; }
        }
      }
      if (truncated) break;
    }

    return { query: input.query, hits, filesScanned, truncated };
  },
});
