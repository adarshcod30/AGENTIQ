/**
 * The filesystem jail: the exact analogue of the SSRF egress guard, for files.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §G. The discovery and static-analysis tools read
 * files from a project workspace. Without a boundary, a tool asked to read
 * `../../../.aws/credentials` would hand back the user's cloud keys, the same way
 * an unguarded fetch of `169.254.169.254` hands back instance credentials.
 *
 * The rule is simple and enforced two ways, because one check is not enough:
 *
 *   1. LEXICAL. The resolved absolute path must sit inside the workspace root.
 *      This catches `..` traversal and absolute paths pointing elsewhere.
 *   2. REALPATH. The real path (symlinks followed) of the target, or of its
 *      nearest existing ancestor, must ALSO sit inside the root. This catches a
 *      symlink inside the workspace that points out of it, which the lexical
 *      check alone would miss.
 *
 * A jail is created from a workspace root that must already exist and be a
 * directory. That root is server-controlled context, never tool input: the LLM
 * proposes a relative path, and the jail decides whether it is allowed. The
 * containment is what makes `local.fs.read` safe to auto-grant, exactly as the
 * egress guard is what makes `http_request` safe to run.
 */
import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';

export class FsJailError extends Error {
  constructor(message, code = 'FS_JAIL_ESCAPE') {
    super(message);
    this.name = 'FsJailError';
    this.code = code;
  }
}

/** True when `child` is `root` itself or lies beneath it. Never a prefix trick. */
function isInside(root, child) {
  if (child === root) return true;
  return child.startsWith(root + path.sep);
}

/**
 * realpath the deepest part of `abs` that exists, so a not-yet-existing file
 * is still checked against a real (symlink-followed) ancestor. Returns the real
 * path of `abs` when it exists, or of its nearest existing parent otherwise.
 */
function realpathOfExisting(abs) {
  let current = abs;
  // Walk up until something exists. The workspace root always exists, so this
  // terminates well before the filesystem root.
  for (;;) {
    try {
      return realpathSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return current; // reached the FS root, give up
      current = parent;
    }
  }
}

/**
 * Creates a jail rooted at `workspaceRoot`.
 *
 * The root is resolved through realpath once, so every later containment check
 * compares real paths against a real root and a symlinked workspace directory
 * does not defeat the guard.
 */
export function createJail(workspaceRoot) {
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    throw new FsJailError('A workspace root is required', 'FS_JAIL_NO_ROOT');
  }
  const resolved = path.resolve(workspaceRoot);
  let root;
  try {
    root = realpathSync(resolved);
  } catch {
    throw new FsJailError(`Workspace root does not exist: ${resolved}`, 'FS_JAIL_NO_ROOT');
  }
  if (!statSync(root).isDirectory()) {
    throw new FsJailError(`Workspace root is not a directory: ${root}`, 'FS_JAIL_NOT_DIR');
  }

  /**
   * Resolves a caller-supplied relative path to a safe absolute path inside the
   * jail, or throws FsJailError. `relPath` must be RELATIVE: an absolute path is
   * refused outright rather than silently confined, because a caller passing
   * `/etc/passwd` is trying to escape and deserves a clear error, not a quiet
   * remap to a nonexistent file inside the workspace.
   */
  function resolve(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new FsJailError('A path is required', 'FS_JAIL_BAD_PATH');
    }
    if (relPath.includes('\0')) {
      throw new FsJailError('A path may not contain a null byte', 'FS_JAIL_BAD_PATH');
    }
    if (path.isAbsolute(relPath)) {
      throw new FsJailError(`An absolute path is not allowed: ${relPath}`, 'FS_JAIL_ABSOLUTE');
    }
    const abs = path.resolve(root, relPath);

    if (!isInside(root, abs)) {
      throw new FsJailError(`Path escapes the workspace: ${relPath}`);
    }
    const real = realpathOfExisting(abs);
    if (!isInside(root, real)) {
      throw new FsJailError(`Path resolves (via a symlink) outside the workspace: ${relPath}`);
    }
    return abs;
  }

  return { root, resolve };
}
