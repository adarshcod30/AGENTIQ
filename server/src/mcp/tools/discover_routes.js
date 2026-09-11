/**
 * discover_routes: the API surface of a project, composed across files.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §E, §I. Walks the workspace and runs the right
 * extractor per framework, composing full paths:
 *
 *   Express : AST (analysis/routes.js). Three mount patterns, composed across
 *             files: direct app routes, imported routers mounted at a prefix, and
 *             a router defined and mounted within one file.
 *   Python  : FastAPI and Flask (analysis/routesPython.js), pattern-based, with
 *             within-file APIRouter/Blueprint prefixes composed in.
 *   Next.js : filesystem convention (analysis/routesNext.js), Pages API and App
 *             Router route handlers.
 *
 * A project can be more than one at once (a Next frontend beside a FastAPI
 * service), so every applicable extractor runs and the results merge. Where a
 * path cannot be composed with confidence, the raw path is still returned and
 * flagged, never dropped.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { analyzeSource, joinPath, pathParams } from '../analysis/routes.js';
import { analyzePython } from '../analysis/routesPython.js';
import { analyzeNext } from '../analysis/routesNext.js';
import { walkWorkspace, readTextInJail } from '../analysis/workspace.js';
import { requireWorkspace } from './fs_read.js';

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const WALK_EXTS = new Set([...JS_EXTS, '.py']);
const RESOLVE_ORDER = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '/index.js', '/index.ts'];
const JS_ROUTE_HINT = /\b(express|Router)\b|\.(get|post|put|patch|delete|use|route)\s*\(/;
const PY_ROUTE_HINT = /@\s*[A-Za-z_][\w.]*\.(?:get|post|put|patch|delete|route|api_route)\s*\(|APIRouter|Blueprint|include_router|register_blueprint/;

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
  frameworks: z.array(z.string()),
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

/**
 * Express extraction: the three composition patterns, unchanged. Returns
 * endpoints and the per-lane stats.
 */
function extractExpress(jail, files) {
  const analyzed = new Map(); // relFile -> analysis
  let filesScanned = 0;
  let parseErrors = 0;
  for (const rel of files) {
    const text = readTextInJail(jail, rel);
    if (text === null || !JS_ROUTE_HINT.test(text)) continue;
    filesScanned += 1;
    const a = analyzeSource(text, { filename: rel });
    if (a.parseError) parseErrors += 1;
    if (a.routes.length || a.mounts.length) analyzed.set(rel, a);
  }

  // Pass 2: external prefixes from cross-file mounts (pattern B).
  const externalPrefix = new Map();
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

  // Pass 3: compose.
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
        method: r.method, path: full, params: pathParams(full),
        file: rel, line: r.line, composed: Boolean(base || within),
      });
    }
  }
  return { endpoints, filesScanned, filesWithRoutes, parseErrors };
}

/**
 * Python extraction: FastAPI and Flask. Composes the within-file APIRouter /
 * Blueprint prefix and any same-file include_router / register_blueprint prefix.
 * Cross-package Python composition is a known gap (docs/10 §I: framework coverage
 * is a long tail); the router-level prefix already gives the right path for the
 * common structured layout, where the prefix lives on the APIRouter itself.
 */
function extractPython(jail, files) {
  const endpoints = [];
  let filesScanned = 0;
  let filesWithRoutes = 0;
  let isFastapi = false;
  let isFlask = false;

  for (const rel of files) {
    const text = readTextInJail(jail, rel);
    if (text === null || !PY_ROUTE_HINT.test(text)) continue;
    filesScanned += 1;
    if (/\bfastapi\b|APIRouter/.test(text)) isFastapi = true;
    if (/\bflask\b|Blueprint/i.test(text)) isFlask = true;

    const a = analyzePython(text, { filename: rel });
    if (!a.routes.length) continue;
    filesWithRoutes += 1;

    const mountPrefixByVar = new Map();
    for (const m of a.mounts) for (const t of m.targets) if (t.var) mountPrefixByVar.set(t.var, m.prefix);

    for (const r of a.routes) {
      const routerPrefix = a.routerPrefixes[r.via] ?? '';
      const mountPrefix = mountPrefixByVar.get(r.via) ?? '';
      const full = joinPath(joinPath(mountPrefix, routerPrefix), r.path);
      endpoints.push({
        method: r.method, path: full, params: pathParams(full),
        file: rel, line: r.line, composed: Boolean(routerPrefix || mountPrefix),
      });
    }
  }

  const framework = isFastapi ? 'fastapi' : (isFlask ? 'flask' : null);
  return { endpoints, filesScanned, filesWithRoutes, framework };
}

export default defineTool({
  name: 'discover_routes',
  title: 'Discover the API surface',
  description:
    'Walk the project workspace and return every HTTP route it declares, with full paths composed '
    + 'across mounted routers. Express, FastAPI and Flask, and Next.js (Pages API and App Router).',
  riskClass: RISK_CLASS.LOCAL_FS_READ,
  inputSchema,
  outputSchema,
  async handler(input, context) {
    const jail = requireWorkspace(context);
    const { files } = walkWorkspace(jail, { maxFiles: input.maxFiles, exts: WALK_EXTS });
    const jsFiles = files.filter((f) => JS_EXTS.has(path.extname(f)));
    const pyFiles = files.filter((f) => path.extname(f) === '.py');

    const express = extractExpress(jail, jsFiles);
    const python = extractPython(jail, pyFiles);
    const next = analyzeNext(files, (rel) => readTextInJail(jail, rel));

    // Which frameworks actually produced routes, and the primary one.
    const contributors = [
      { name: 'express', endpoints: express.endpoints },
      { name: python.framework, endpoints: python.endpoints },
      { name: 'next', endpoints: next.endpoints },
    ].filter((c) => c.name && c.endpoints.length);

    const frameworks = contributors.map((c) => c.name);
    const primary = contributors.slice().sort((a, b) => b.endpoints.length - a.endpoints.length)[0]?.name
      ?? 'express';

    // Merge and de-duplicate on method + path.
    const all = [...express.endpoints, ...python.endpoints, ...next.endpoints];
    const seen = new Set();
    const unique = all
      .sort((x, y) => (x.path === y.path ? x.method.localeCompare(y.method) : x.path.localeCompare(y.path)))
      .filter((e) => {
        const k = `${e.method} ${e.path}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    return {
      framework: primary,
      frameworks,
      endpoints: unique,
      stats: {
        filesScanned: express.filesScanned + python.filesScanned,
        filesWithRoutes: express.filesWithRoutes + python.filesWithRoutes,
        routesFound: unique.length,
        parseErrors: express.parseErrors,
      },
    };
  },
});
