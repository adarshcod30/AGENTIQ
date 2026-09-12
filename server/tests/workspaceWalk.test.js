/**
 * The workspace walker's file matching, with emphasis on the dotfile blind spot.
 *
 * path.extname('.env') === '', because Node reads a leading dot as a hidden-file
 * marker rather than an extension. So an extension filter alone silently skips
 * the canonical secret files, which is precisely where a leaked credential is
 * most likely to sit. These tests pin the fix: `matchName` reaches `.env` and
 * friends, secret_scan's own matcher recognises them, and the real secret is
 * masked in the evidence, never printed in full.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJail } from '../src/mcp/fsJail.js';
import { walkWorkspace, collectWorkspaceFiles, SOURCE_EXTS } from '../src/mcp/analysis/workspace.js';
import { isSecretFile } from '../src/mcp/tools/secret_scan.js';
import { scanSecrets } from '../src/mcp/analysis/secretScan.js';

let root;
let jail;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-walk-'));
  writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');
  writeFileSync(path.join(root, '.env'), 'AWS_SECRET=AKIAIOSFODNN7EXAMPLE\n');
  writeFileSync(path.join(root, '.env.production'), 'DB=mongodb+srv://u:supersecret@c.net/db\n');
  writeFileSync(path.join(root, '.env.example'), 'AWS_SECRET=your-key-here\n');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', '.env'), 'GOOGLE=AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe\n');
  jail = createJail(root);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('isSecretFile', () => {
  it('matches env files and known credential filenames, not ordinary source', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('.env.production')).toBe(true);
    expect(isSecretFile('id_rsa')).toBe(true);
    expect(isSecretFile('.npmrc')).toBe(true);
    expect(isSecretFile('index.js')).toBe(false);
    expect(isSecretFile('config.json')).toBe(false);
  });
});

describe('walkWorkspace name matching', () => {
  it('skips dot-led env files when only an extension filter is given', () => {
    // Documents the blind spot the fix closes: extname('.env') === '' so an
    // ext-only walk never yields it. This is why secret_scan was blind to .env.
    const { files } = walkWorkspace(jail, { exts: SOURCE_EXTS });
    expect(files).toContain('index.js');
    expect(files).not.toContain('.env');
  });

  it('reaches .env, .env.production and a nested .env via matchName', () => {
    const { files } = walkWorkspace(jail, { exts: SOURCE_EXTS, matchName: isSecretFile });
    expect(files).toContain('.env');
    expect(files).toContain('.env.production');
    expect(files).toContain(path.join('src', '.env'));
  });
});

describe('secret_scan reaches real .env content', () => {
  it('collects and scans env files, finds real keys, skips the example, masks the value', () => {
    const { files } = collectWorkspaceFiles(jail, {
      exts: new Set([...SOURCE_EXTS, '.pem']),
      matchName: isSecretFile,
    });
    const findings = scanSecrets(files);
    const cats = findings.map((f) => f.category);
    expect(cats).toContain('aws-access-key'); // from .env
    expect(cats).toContain('mongo-uri-with-password'); // from .env.production
    expect(cats).toContain('google-api-key'); // from src/.env

    const evidence = findings.map((f) => f.evidence).join('\n');
    // The committed example is walked but scanContentForSecrets skips it.
    expect(evidence).not.toContain('your-key-here');
    // The real AWS key is masked: the report never becomes the leak.
    expect(evidence).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(evidence).toContain('AK***LE');
  });
});
