/**
 * The SSRF and open-redirect DETECTORS, in isolation.
 *
 * These pure functions decide whether a response is evidence of a defect. The
 * cases that matter most are the ones that must NOT fire: a reflected URL
 * string, a same-site redirect, a host name echoed without any sign of a
 * server-side request. A probe that flagged those would be noise, and noise is
 * what makes a reader stop trusting the findings that are real.
 */
import { describe, it, expect } from 'vitest';
import {
  SSRF_PARAM_NAMES, REDIRECT_PARAM_NAMES,
  looksLikeUrlValue, urlParamTargets, withParam,
  detectSsrf, SSRF_CANARIES,
  redirectCanary, isOpenRedirect, REDIRECT_CANARY_HOST,
} from '../src/mcp/probes/ssrfRedirect.js';
import { isSafeRelativePath } from '../../fixtures/shared/data.js';

const META = SSRF_CANARIES.find((c) => c.kind === 'metadata');
const PRIVATE = SSRF_CANARIES.find((c) => c.kind === 'private');

describe('detectSsrf', () => {
  it('fires CRITICAL when the body carries metadata content', () => {
    const body = { url: 'x', ok: true, body: '{"Code":"Success","AccessKeyId":"ASIA..."}' };
    const v = detectSsrf(body, META);
    expect(v.vulnerable).toBe(true);
    expect(v.severity).toBe('critical');
  });

  it('fires HIGH when the injected host is echoed beside a socket error', () => {
    const body = { ok: false, error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:9' };
    const v = detectSsrf(body, PRIVATE);
    expect(v.vulnerable).toBe(true);
    expect(v.severity).toBe('high');
  });

  it('does NOT fire on a reflected URL string alone', () => {
    // The classic false positive: the endpoint echoes the value, nothing more.
    const body = { error: `Unknown target: ${META.value}` };
    expect(detectSsrf(body, META).vulnerable).toBe(false);
  });

  it('does NOT fire on a socket error that names a DIFFERENT host', () => {
    const body = { error: 'connect ECONNREFUSED 10.0.0.5:443' };
    expect(detectSsrf(body, PRIVATE).vulnerable).toBe(false);
  });

  it('does NOT fire on the word "failed" in ordinary prose', () => {
    const body = { error: `validation failed for ${PRIVATE.value}` };
    expect(detectSsrf(body, PRIVATE).vulnerable).toBe(false);
  });

  it('is silent on an empty body', () => {
    expect(detectSsrf('', META).vulnerable).toBe(false);
  });
});

describe('isOpenRedirect', () => {
  const canary = redirectCanary('abcd1234');
  const requestUrl = `http://target.test/go?next=${encodeURIComponent(canary)}`;

  it('fires on a 3xx Location that jumps to the canary host', () => {
    const v = isOpenRedirect({ status: 302, location: canary, requestUrl });
    expect(v.vulnerable).toBe(true);
    expect(v.to).toContain(REDIRECT_CANARY_HOST);
  });

  it('fires on a protocol-relative Location to the canary host', () => {
    const v = isOpenRedirect({ status: 302, location: `//${REDIRECT_CANARY_HOST}/x`, requestUrl });
    expect(v.vulnerable).toBe(true);
  });

  it('does NOT fire on a same-site relative Location', () => {
    expect(isOpenRedirect({ status: 302, location: '/', requestUrl }).vulnerable).toBe(false);
    expect(isOpenRedirect({ status: 302, location: '/dashboard', requestUrl }).vulnerable).toBe(false);
  });

  it('does NOT fire on a redirect to some other external host', () => {
    expect(isOpenRedirect({ status: 302, location: 'https://example.com/', requestUrl }).vulnerable).toBe(false);
  });

  it('does NOT fire on a 200 that merely carries a location header', () => {
    expect(isOpenRedirect({ status: 200, location: canary, requestUrl }).vulnerable).toBe(false);
  });

  it('does NOT fire when there is no Location at all', () => {
    expect(isOpenRedirect({ status: 302, location: undefined, requestUrl }).vulnerable).toBe(false);
  });
});

describe('parameter selection', () => {
  it('prefers a present parameter whose NAME looks like a URL sink', () => {
    expect(urlParamTargets('http://t/page?id=1&url=x', { names: SSRF_PARAM_NAMES, fallback: ['url'] }))
      .toEqual(['url']);
  });

  it('picks a parameter whose VALUE already looks like a URL', () => {
    const picked = urlParamTargets('http://t/p?to=https://a.com/x', {
      names: REDIRECT_PARAM_NAMES, fallback: ['next'],
    });
    expect(picked).toContain('to');
  });

  it('falls back to the given names when nothing matches', () => {
    expect(urlParamTargets('http://t/p?q=hello', { names: SSRF_PARAM_NAMES, fallback: ['url'] }))
      .toEqual(['url']);
  });

  it('caps the number of targets', () => {
    const many = 'http://t/p?url=a&uri=b&src=c&link=d&target=e&dest=f';
    expect(urlParamTargets(many, { names: SSRF_PARAM_NAMES, fallback: ['url'], limit: 4 }).length)
      .toBeLessThanOrEqual(4);
  });

  it('withParam sets exactly one query value', () => {
    expect(withParam('http://t/p?a=1', 'a', 'http://169.254.169.254/'))
      .toBe('http://t/p?a=http%3A%2F%2F169.254.169.254%2F');
  });
});

describe('looksLikeUrlValue', () => {
  it.each([
    ['http://a.com', true],
    ['https://a.com/x', true],
    ['//a.com/x', true],
    ['example.com/path', true],
    ['/local/path', false],
    ['42', false],
    ['', false],
  ])('%s -> %s', (value, expected) => {
    expect(looksLikeUrlValue(value)).toBe(expected);
  });
});

describe('isSafeRelativePath (hardened /go)', () => {
  it.each([
    ['/', true],
    ['/dashboard', true],
    ['//evil.example', false],
    ['/\\evil.example', false],
    ['https://evil.example', false],
    ['', false],
  ])('%s -> %s', (next, expected) => {
    expect(isSafeRelativePath(next)).toBe(expected);
  });
});
