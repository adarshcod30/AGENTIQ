/**
 * Reads a local project folder into the [{ path, content }] list the upload
 * endpoint expects, applying the same rules the browser does: skip build output
 * and binaries, cap the size, and refuse to follow symlinks out of the tree. The
 * server enforces these limits again, this just fails fast and keeps the upload
 * small.
 */
import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.nyc_output',
  '.cache', '.turbo', '.parcel-cache', 'vendor', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.svelte-kit', 'target', 'bin', 'obj',
]);
const BINARY_RE = /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|tar|rar|7z|mp4|mov|avi|mkv|mp3|wav|flac|woff2?|ttf|eot|otf|bin|exe|dll|so|dylib|class|jar|wasm|lock|map|node|psd|sqlite|db)$/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 3000;

export function readFolder(root) {
  const base = path.resolve(root);
  const stat = fs.statSync(base); // throws a clear ENOENT if the path is wrong
  if (!stat.isDirectory()) throw new Error(`${base} is not a folder`);

  const files = [];
  let total = 0;
  let skipped = 0;

  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) return;
      if (ent.isSymbolicLink()) { skipped += 1; continue; }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) { skipped += 1; continue; }
        walk(full);
      } else if (ent.isFile()) {
        if (BINARY_RE.test(ent.name) || fs.statSync(full).size > MAX_FILE_BYTES) { skipped += 1; continue; }
        const rel = path.relative(base, full).split(path.sep).join('/');
        const content = fs.readFileSync(full, 'utf8');
        total += Buffer.byteLength(content, 'utf8');
        if (total > MAX_TOTAL_BYTES) { skipped += 1; continue; }
        files.push({ path: rel, content });
      }
    }
  };
  walk(base);

  return { name: path.basename(base), files, skipped };
}
