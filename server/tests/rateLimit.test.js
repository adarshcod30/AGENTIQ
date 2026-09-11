/**
 * The resend limiter keys IPv6 clients by prefix, not by full address.
 *
 * A custom keyGenerator that used the raw IP would let a client with an IPv6
 * range use a fresh /128 per request and never hit the limit. ipKeyGenerator
 * collapses the range to one key, so the budget applies to the range as a whole.
 */
import { describe, it, expect } from 'vitest';
import { resendRateKey } from '../src/routes/auth.routes.js';

describe('resendRateKey', () => {
  it('keys by user id when the request is authenticated', () => {
    expect(resendRateKey({ user: { _id: 'abc123' }, ip: '203.0.113.9' })).toBe('abc123');
  });

  it('falls back to the IP when there is no user', () => {
    expect(resendRateKey({ ip: '203.0.113.9' })).toBe('203.0.113.9');
  });

  it('collapses two addresses in one IPv6 range to the same key', () => {
    const a = resendRateKey({ ip: '2001:db8:1:2:aaaa::1' });
    const b = resendRateKey({ ip: '2001:db8:1:2:bbbb::2' });
    expect(a).toBe(b);
    expect(a).toContain('/'); // a prefix, not a full address
  });

  it('does not throw when the IP is missing', () => {
    expect(() => resendRateKey({})).not.toThrow();
  });
});
