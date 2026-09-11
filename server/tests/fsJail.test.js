/**
 * The filesystem jail: it must refuse every way out of the workspace.
 *
 * This is the filesystem counterpart to egress.test.js. Where that suite proves
 * the SSRF guard blocks every private range, this one proves the fs jail blocks
 * every path that would escape the workspace root.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJail, FsJailError } from '../src/mcp/fsJail.js';

let root;
let outside;

beforeAll(() => {
  // A workspace with a file, a subdirectory, and two symlinks: one that stays
  // inside and one that points out. The escape symlink is the case a lexical
  // check alone would wave through.
  root = mkdtempSync(path.join(tmpdir(), 'jail-root-'));
  outside = mkdtempSync(path.join(tmpdir(), 'jail-outside-'));
  writeFileSync(path.join(root, 'app.js'), 'export const x = 1;\n');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'index.js'), '// inside\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'AKIA-not-really\n');
  symlinkSync(path.join(root, 'src'), path.join(root, 'link-inside'));
  symlinkSync(outside, path.join(root, 'link-out'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('createJail', () => {
  it('rejects a root that does not exist', () => {
    expect(() => createJail(path.join(root, 'nope'))).toThrow(FsJailError);
  });

  it('rejects a root that is a file, not a directory', () => {
    expect(() => createJail(path.join(root, 'app.js'))).toThrow(/not a directory/);
  });

  it('rejects an empty root', () => {
    expect(() => createJail('')).toThrow(FsJailError);
  });
});

describe('resolve: paths inside the workspace are allowed', () => {
  it('resolves a file at the root', () => {
    const jail = createJail(root);
    expect(jail.resolve('app.js')).toBe(path.join(jail.root, 'app.js'));
  });

  it('resolves a nested file', () => {
    const jail = createJail(root);
    expect(jail.resolve('src/index.js')).toBe(path.join(jail.root, 'src', 'index.js'));
  });

  it('resolves a not-yet-existing file inside the root (for writes later)', () => {
    const jail = createJail(root);
    expect(jail.resolve('src/new.js')).toBe(path.join(jail.root, 'src', 'new.js'));
  });

  it('follows a symlink that stays inside the workspace', () => {
    const jail = createJail(root);
    // link-inside -> src, so link-inside/index.js is really src/index.js
    expect(() => jail.resolve('link-inside/index.js')).not.toThrow();
  });
});

describe('resolve: every escape is refused', () => {
  const escapes = [
    ['parent traversal', '../secret.txt'],
    ['deep traversal', '../../../../../../etc/passwd'],
    ['traversal after a real segment', 'src/../../secret.txt'],
    ['absolute path outside', '/etc/passwd'],
    ['absolute path anywhere', path.join(tmpdir(), 'anything')],
  ];

  it.each(escapes)('refuses %s', (_label, rel) => {
    const jail = createJail(root);
    expect(() => jail.resolve(rel)).toThrow(FsJailError);
  });

  it('refuses a symlink that points out of the workspace (realpath check)', () => {
    const jail = createJail(root);
    // link-out -> outside, so link-out/secret.txt would escape. The lexical
    // check passes (link-out is under root); only the realpath check catches it.
    expect(() => jail.resolve('link-out/secret.txt')).toThrow(/symlink/i);
  });

  it('refuses a null byte in the path', () => {
    const jail = createJail(root);
    expect(() => jail.resolve('app.js\0.txt')).toThrow(FsJailError);
  });

  it('refuses an empty path', () => {
    const jail = createJail(root);
    expect(() => jail.resolve('')).toThrow(FsJailError);
  });
});
