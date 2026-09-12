/**
 * Cloning a public Git repository into a workspace, so a GitHub repo can be
 * assessed like a local folder.
 *
 * SAFETY, because this is the one place the platform pulls in code it did not
 * write:
 *
 *   - It runs `git`, and nothing else. execFile passes the URL as a single
 *     argument with NO shell, so a URL can never inject a command.
 *   - Only public https github.com URLs are accepted (normalizeGithubUrl).
 *   - The clone is shallow (--depth 1), single-branch and tagless, and does NOT
 *     recurse submodules: a submodule can point at an arbitrary host.
 *   - GIT_TERMINAL_PROMPT=0 makes a private repo fail fast instead of hanging on
 *     a credential prompt, and the environment is scrubbed.
 *   - Cloning does not execute the repo's code (git runs none of its hooks on a
 *     clone). The code is still UNTRUSTED afterwards: the caller marks the
 *     project trusted:false so the assessment never runs its scripts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);

export class GitError extends Error {
  constructor(message, code = 'GIT_ERROR') {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

/** Where clones are written. Overridable, defaults to a temp subdirectory. */
export function clonesRoot() {
  return process.env.AGENTIQ_CLONES_DIR || path.join(os.tmpdir(), 'agentiq-clones');
}

/** Only public https GitHub repo URLs: https://github.com/<owner>/<repo>[.git]. */
const GITHUB_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?$/;

/** Validates and canonicalises a GitHub URL, or throws GitError. */
export function normalizeGithubUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!GITHUB_RE.test(url)) {
    throw new GitError(
      'Only public https GitHub repository URLs are supported, e.g. https://github.com/owner/repo',
      'INVALID_REPO_URL',
    );
  }
  return url.replace(/\/$/, '');
}

/**
 * Shallow-clones a public GitHub repo and returns its canonical local path.
 *
 * @returns {Promise<{ path: string, repoUrl: string }>}
 */
export async function cloneRepo({ url, timeoutMs = 60_000 } = {}) {
  const repoUrl = normalizeGithubUrl(url);
  mkdirSync(clonesRoot(), { recursive: true });
  const dest = mkdtempSync(path.join(clonesRoot(), 'repo-'));

  try {
    await execFileP(
      'git',
      ['clone', '--depth', '1', '--single-branch', '--no-tags', repoUrl, dest],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // Scrubbed: no inherited credentials, no system git config, no prompts.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: os.tmpdir(),
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    );
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    const detail = String(err.stderr || err.message || '').split('\n').find(Boolean) ?? 'clone failed';
    if (err.killed || /timed out/i.test(String(err.message))) {
      throw new GitError('Cloning timed out. Is the repository very large?', 'CLONE_TIMEOUT');
    }
    if (/not found|could not read|authentication|access denied|repository .* not found/i.test(detail)) {
      throw new GitError('Repository not found or not public. Only public GitHub repos can be cloned.', 'REPO_NOT_ACCESSIBLE');
    }
    throw new GitError(`Could not clone the repository: ${detail}`, 'CLONE_FAILED');
  }

  return { path: realpathSync(dest), repoUrl };
}

export default { cloneRepo, normalizeGithubUrl, clonesRoot, GitError };
