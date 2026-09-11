/**
 * Bounded, jail-safe traversal of a project workspace.
 *
 * Shared by code_search and discover_routes. Every path it yields has already
 * passed through the jail, and it never descends into the directories that make
 * a repository huge and uninteresting (dependencies, build output, version
 * control). The file count is capped so a pathological workspace cannot make a
 * tool run unbounded.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Never worth walking: dependencies, build output, VCS, coverage, caches. */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.cache', '.turbo', 'out', 'vendor', '__pycache__', '.venv', 'venv',
]);

/** Source extensions discovery and search care about. */
export const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.yml', '.yaml',
]);

/**
 * Walks the workspace, returning workspace-relative paths for files that match.
 *
 * @param jail        a jail from createJail (its root is the traversal root)
 * @param maxFiles    stop after this many matches (default 5000)
 * @param exts        only return files with these extensions (default SOURCE_EXTS)
 * @param filter      optional (relPath) => boolean applied after the ext filter
 */
export function walkWorkspace(jail, { maxFiles = 5000, exts = SOURCE_EXTS, filter = null } = {}) {
  const out = [];
  const stack = [''];

  while (stack.length && out.length < maxFiles) {
    const relDir = stack.pop();
    let entries;
    try {
      entries = readdirSync(path.join(jail.root, relDir), { withFileTypes: true });
    } catch {
      continue; // unreadable directory, skip rather than fail the whole walk
    }
    for (const entry of entries) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks, sockets, devices
      if (exts && !exts.has(path.extname(entry.name))) continue;
      if (filter && !filter(rel)) continue;
      out.push(rel);
      if (out.length >= maxFiles) break;
    }
  }
  return { files: out, truncated: out.length >= maxFiles };
}

/**
 * Walks the workspace and returns readable files as { path, content }, bounded
 * on count and per-file size. Skips files that could not be read. Shared by the
 * static analysis tools, which all need the same "give me the source" step.
 */
export function collectWorkspaceFiles(jail, { maxFiles = 5000, exts = SOURCE_EXTS, maxBytes = 512 * 1024 } = {}) {
  const { files, truncated } = walkWorkspace(jail, { maxFiles, exts });
  const out = [];
  for (const rel of files) {
    const content = readTextInJail(jail, rel, maxBytes);
    if (content !== null) out.push({ path: rel, content });
  }
  return { files: out, truncated };
}

/**
 * Reads a workspace file as UTF-8 text through the jail, capped at maxBytes.
 * Returns null for a file that does not exist or is not readable, so a caller
 * walking many files is not derailed by one bad entry.
 */
export function readTextInJail(jail, relPath, maxBytes = 512 * 1024) {
  let abs;
  try {
    abs = jail.resolve(relPath);
  } catch {
    return null;
  }
  try {
    if (statSync(abs).size > maxBytes) {
      return readFileSync(abs, 'utf8').slice(0, maxBytes);
    }
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}
