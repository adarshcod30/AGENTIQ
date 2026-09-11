/**
 * IP classification: one test per blocked range (docs/02_TRD.md §7).
 *
 * These are pure functions with no network involved, so they run in
 * milliseconds and can be exhaustive. This file is the evidence behind the
 * claim "AGENTIQ cannot be used as an SSRF proxy".
 */
import { describe, it, expect } from 'vitest';
import {
  classifyIp, isBlockedIp, isBlockedHostname, expandIpv6, extractMappedIpv4, BLOCK_REASONS,
} from '../src/mcp/ipRules.js';

describe('IPv4: blocked ranges', () => {
  it.each([
    ['127.0.0.1', BLOCK_REASONS.LOOPBACK, 'loopback'],
    ['127.255.255.254', BLOCK_REASONS.LOOPBACK, 'loopback, upper end of /8'],
    ['10.0.0.1', BLOCK_REASONS.PRIVATE, 'RFC1918 10/8'],
    ['172.16.0.1', BLOCK_REASONS.PRIVATE, 'RFC1918 172.16/12 lower'],
    ['172.31.255.254', BLOCK_REASONS.PRIVATE, 'RFC1918 172.16/12 upper'],
    ['192.168.1.1', BLOCK_REASONS.PRIVATE, 'RFC1918 192.168/16'],
    ['169.254.169.254', BLOCK_REASONS.LINK_LOCAL, 'AWS/GCP instance metadata'],
    ['169.254.0.1', BLOCK_REASONS.LINK_LOCAL, 'link-local'],
    ['0.0.0.0', BLOCK_REASONS.UNSPECIFIED, 'unspecified'],
    ['0.1.2.3', BLOCK_REASONS.UNSPECIFIED, '0/8'],
    ['224.0.0.1', BLOCK_REASONS.MULTICAST, 'multicast'],
    ['239.255.255.255', BLOCK_REASONS.MULTICAST, 'multicast upper'],
    ['100.64.0.1', BLOCK_REASONS.CARRIER_NAT, 'CGNAT'],
    ['255.255.255.255', BLOCK_REASONS.RESERVED, 'broadcast'],
    ['240.0.0.1', BLOCK_REASONS.RESERVED, 'reserved 240/4'],
    ['192.0.0.1', BLOCK_REASONS.RESERVED, 'IETF protocol assignments 192.0.0/24'],
    ['192.0.2.1', BLOCK_REASONS.RESERVED, 'TEST-NET-1 documentation range'],
    ['192.88.99.1', BLOCK_REASONS.RESERVED, '6to4 relay anycast 192.88.99/24'],
    ['198.18.0.1', BLOCK_REASONS.RESERVED, 'benchmarking 198.18/15'],
    ['198.51.100.1', BLOCK_REASONS.RESERVED, 'TEST-NET-2 documentation range'],
    ['203.0.113.1', BLOCK_REASONS.RESERVED, 'TEST-NET-3 documentation range'],
  ])('blocks %s (%s)', (ip, reason) => {
    const verdict = classifyIp(ip);
    expect(verdict.blocked, `${ip} must be blocked`).toBe(true);
    expect(verdict.reason).toBe(reason);
  });
});

describe('IPv4: public addresses must NOT be blocked', () => {
  it.each([
    ['8.8.8.8', 'Google DNS'],
    ['1.1.1.1', 'Cloudflare DNS'],
    ['140.82.121.4', 'github.com'],
    ['172.15.255.255', 'just below the 172.16/12 private block'],
    ['172.32.0.1', 'just above the 172.16/12 private block'],
    ['100.63.255.255', 'just below CGNAT'],
    ['169.253.255.255', 'just below link-local'],
    ['169.255.0.0', 'just above link-local'],
  ])('allows %s (%s)', (ip) => {
    expect(isBlockedIp(ip), `${ip} must be allowed`).toBe(false);
  });
});

describe('IPv6: blocked ranges', () => {
  it.each([
    ['::1', BLOCK_REASONS.LOOPBACK, 'loopback'],
    ['::', BLOCK_REASONS.UNSPECIFIED, 'unspecified'],
    ['fe80::1', BLOCK_REASONS.LINK_LOCAL, 'link-local'],
    ['febf:ffff::1', BLOCK_REASONS.LINK_LOCAL, 'fe80::/10 upper'],
    ['fc00::1', BLOCK_REASONS.UNIQUE_LOCAL, 'ULA fc00::/7'],
    ['fd12:3456::1', BLOCK_REASONS.UNIQUE_LOCAL, 'ULA fd00::/8'],
    ['ff02::1', BLOCK_REASONS.MULTICAST, 'multicast'],
  ])('blocks %s (%s)', (ip, reason) => {
    const verdict = classifyIp(ip);
    expect(verdict.blocked, `${ip} must be blocked`).toBe(true);
    expect(verdict.reason).toBe(reason);
  });

  it('allows a public IPv6 address', () => {
    expect(isBlockedIp('2606:4700:4700::1111')).toBe(false); // Cloudflare
  });
});

describe('IPv4-mapped IPv6: the classic guard bypass', () => {
  // ::ffff:127.0.0.1 looks like IPv6 to a naive check but routes to loopback.
  it.each([
    ['::ffff:127.0.0.1', BLOCK_REASONS.LOOPBACK],
    ['::ffff:169.254.169.254', BLOCK_REASONS.LINK_LOCAL],
    ['::ffff:10.0.0.1', BLOCK_REASONS.PRIVATE],
    ['::ffff:192.168.1.1', BLOCK_REASONS.PRIVATE],
  ])('unwraps and blocks %s', (ip, reason) => {
    const verdict = classifyIp(ip);
    expect(verdict.blocked, `${ip} must be blocked`).toBe(true);
    expect(verdict.reason).toBe(reason);
  });

  it('also handles the hex form of a mapped address', () => {
    // ::ffff:7f00:1 is ::ffff:127.0.0.1 written in hex.
    expect(classifyIp('::ffff:7f00:1').reason).toBe(BLOCK_REASONS.LOOPBACK);
  });

  it('does not misclassify a genuinely public mapped address', () => {
    expect(isBlockedIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('extractMappedIpv4 returns the embedded address', () => {
    expect(extractMappedIpv4(expandIpv6('::ffff:169.254.169.254'))).toBe('169.254.169.254');
    expect(extractMappedIpv4(expandIpv6('2606:4700::1111'))).toBeNull();
  });
});

describe('IPv6 expansion', () => {
  it('expands compressed notation to eight groups', () => {
    expect(expandIpv6('::1')).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
    expect(expandIpv6('fe80::1')).toBe('fe80:0000:0000:0000:0000:0000:0000:0001');
  });

  it('strips a zone index (fe80::1%eth0)', () => {
    expect(classifyIp('fe80::1%eth0').blocked).toBe(true);
  });

  it('rejects malformed input rather than allowing it through', () => {
    expect(expandIpv6('gggg::1')).toBeNull();
    expect(expandIpv6('1::2::3')).toBeNull();
    // Unparseable input must fail CLOSED: blocked, not allowed.
    expect(classifyIp('not-an-ip').blocked).toBe(true);
  });
});

describe('hostname suffix blocking', () => {
  it.each([
    'localhost', 'LOCALHOST', 'printer.local', 'db.internal',
    'metadata.google.internal', 'host.localdomain', 'thing.home.arpa',
    'localhost.',
  ])('blocks %s', (h) => {
    expect(isBlockedHostname(h), `${h} must be blocked`).toBe(true);
  });

  it.each(['example.com', 'api.github.com', 'localhost.example.com', 'notlocal'])(
    'allows %s',
    (h) => {
      expect(isBlockedHostname(h)).toBe(false);
    },
  );
});
