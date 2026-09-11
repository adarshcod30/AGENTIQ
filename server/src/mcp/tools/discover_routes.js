/**
 * discover_routes: the API surface of an Express project, composed across files.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §E. This is the tool the discovery agent leans
 * on. It walks the workspace, runs the AST extractor over every file that looks
 * like it declares routes, and composes full paths from three patterns:
 *
 *   A. routes defined directly on the app in one file (small apps, the fixtures)
 *   B. an app that mounts imported routers at prefixes, each router file holding
 *      sub-paths (the common structured layout, including AGENTIQ itself)
 *   C. a router defined and mounted within one file
 *
 * Cross-file composition (B) resolves `app.use('/api/x', require('./routes/x'))`
 * to the router file and prefixes its routes. Where a path cannot be composed
 * with confidence, the raw path is still returned and flagged, never dropped.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { analyzeSource, joinPath } from '../analysis/routes.js';
import { walkWorkspace, readTextInJail } from '../analysis/workspace.js';
import { requireWorkspace } from './fs_read.js';

const CODE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const RESOLVE_ORDER = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '/index.js', '/index.ts'];
const ROUTE_HINT = /\b(express|Router)\b|\.(get|post|put|patch|delete|use|route)\s*\(/;

export const inputSchema = z.object({
  maxFiles: z.number().int().positive().max(20000).default(5000),
});

const endpoint = z.object({
  method: z.string(),
  path: z.string(),
  params: z.array(z.string()),
  file: z.string(),
  line: z.number().nullable(),
  composed: z.boolean(),
});

export const outputSchema = z.object({
  framework: z.string(),
  endpoints: z.array(endpoint),
  stats: z.object({
    filesScanned: z.number(),
    filesWithRoutes: z.number(),
    routesFound: z.number(),
    parseErrors: z.number(),
  }),
});

/** Resolve an import source, relative to the importing file, to a workspace file. */
export function resolveImport(jail, fromRelFile, source) {
  if (!source || (!source.startsWith('.') && !source.startsWith('/'))) return null; // a package, not a file
  const baseDir = path.dirname(fromRelFile);
  for (const suffix of RESOLVE_ORDER) {
    const candidate = path.normalize(path.join(baseDir, source + suffix));
    try {
      const abs = jail.resolve(candidate);
      if (existsSync(abs)) return candidate.split(path.sep).join('/');
    } catch {
      // escaped the jail; not a valid workspace file
    }
  }
  return null;
}

export default defineTool({
  name: 'discover_routes',
  title: 'Discover the API surface',
  description:
    'Walk the project workspace and return every HTTP route it declares, with full paths composed '
    + 'across mounted routers. Express projects today; other frameworks are added over time.',
  riskClass: RISK_CLASS.LOCAL_FS_READ,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const { files } = walkWorkspace(jail, { maxFiles: input.maxFiles, exts: CODE_EXTS });

    // Pass 1: analyze every candidate file.
    const analyzed = new Map(); // relFile -> analysis
    let filesScanned = 0;
    let parseErrors = 0;
    for (const rel of files) {
      const text = readTextInJail(jail, rel);
      if (text === null || !ROUTE_HINT.test(text)) continue;
      filesScanned += 1;
      const a = analyzeSource(text, { filename: rel });
      if (a.parseError) parseErrors += 1;
      if (a.routes.length || a.mounts.length) analyzed.set(rel, a);
    }

    // Pass 2: external prefixes from cross-file mounts (pattern B).
    const externalPrefix = new Map(); // relFile -> prefix applied by an importer
    for (const [rel, a] of analyzed) {
      for (const m of a.mounts) {
        for (const t of m.targets) {
          const source = t.import ?? (t.var ? a.imports[t.var] : null);
          if (!source) continue;
          const target = resolveImport(jail, rel, source);
          if (target && !externalPrefix.has(target)) externalPrefix.set(target, m.prefix);
        }
      }
    }

    // Pass 3: compose. Within-file prefixes (pattern C) come from a mount whose
    // targetVar is a router declared in the same file.
    const endpoints = [];
    let filesWithRoutes = 0;
    for (const [rel, a] of analyzed) {
      if (!a.routes.length) continue;
      filesWithRoutes += 1;
      const base = externalPrefix.get(rel) ?? '';
      const withinByVar = new Map();
      for (const m of a.mounts) {
        for (const t of m.targets) {
          if (t.var && a.routers.includes(t.var)) withinByVar.set(t.var, m.prefix);
        }
      }
      for (const r of a.routes) {
        const within = withinByVar.get(r.via) ?? '';
        const full = joinPath(joinPath(base, within), r.path);
        endpoints.push({
          method: r.method,
          path: full,
          params: r.params,
          file: rel,
          line: r.line,
          composed: Boolean(base || within),
        });
      }
    }

    // Stable, de-duplicated order.
    const seen = new Set();
    const unique = endpoints
      .sort((x, y) => (x.path === y.path ? x.method.localeCompare(y.method) : x.path.localeCompare(y.path)))
      .filter((e) => {
        const k = `${e.method} ${e.path}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    return {
      framework: 'express',
      endpoints: unique,
      stats: {
        filesScanned,
        filesWithRoutes,
        routesFound: unique.length,
        parseErrors,
      },
    };
  },
});
