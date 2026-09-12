/**
 * The Git clone service's URL guard. Pure, no network: it decides which URLs are
 * even allowed to reach `git`, which is the first line of defence for the one
 * place the platform pulls in code it did not write.
 */
import { describe, it, expect } from 'vitest';
import { normalizeGithubUrl, authedCloneUrl, GitError } from '../src/services/git.service.js';

describe('normalizeGithubUrl', () => {
  it('accepts a public https GitHub repo URL, with or without .git or a trailing slash', () => {
    expect(normalizeGithubUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
    expect(normalizeGithubUrl('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
    expect(normalizeGithubUrl('https://github.com/owner/repo/')).toBe('https://github.com/owner/repo');
    expect(normalizeGithubUrl('  https://github.com/a-b/c.d_e ')).toBe('https://github.com/a-b/c.d_e');
  });

  it('rejects non-GitHub hosts, http, ssh, lookalikes and injection attempts', () => {
    const bad = [
      'http://github.com/owner/repo', // not https
      'https://gitlab.com/owner/repo', // not github
      'git@github.com:owner/repo.git', // ssh form
      'https://github.com/owner', // no repo segment
      'https://github.com.evil.com/owner/repo', // lookalike host
      'https://evil.com/github.com/owner/repo', // github in the path, not the host
      'https://github.com/owner/repo; rm -rf /', // shell injection attempt
      'file:///etc/passwd',
      '',
    ];
    for (const url of bad) {
      expect(() => normalizeGithubUrl(url), url).toThrow(GitError);
    }
  });
});

describe('authedCloneUrl', () => {
  it('embeds an url-encoded token for a private clone', () => {
    expect(authedCloneUrl('https://github.com/o/r', 'ghp_ab/cd'))
      .toBe('https://x-access-token:ghp_ab%2Fcd@github.com/o/r');
  });

  it('returns the plain url when there is no token', () => {
    expect(authedCloneUrl('https://github.com/o/r', null)).toBe('https://github.com/o/r');
    expect(authedCloneUrl('https://github.com/o/r', '')).toBe('https://github.com/o/r');
  });
});
