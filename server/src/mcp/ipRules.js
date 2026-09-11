/**
 * IP classification for the egress guard.
 *
 * Kept in its own module because these rules are the security boundary and
 * deserve to be tested in isolation from any network behaviour. See
 * docs/02_TRD.md §7.
 *
 * The single most important entry here is 169.254.0.0/16. That is the cloud
 * instance metadata range: on AWS, http://169.254.169.254/latest/meta-data/
 * returns the credentials of whatever role the container is running as. AGENTIQ
 * fetches user-supplied URLs from the server, so without this file the product
 * is a credential-exfiltration service with a testing UI on the front.
 */
import { isIP } from 'node:net';

/** Reasons are stable strings: they end up in audit rows and error messages. */
export const BLOCK_REASONS = {
  LOOPBACK: 'loopback address',
  PRIVATE: 'private network address (RFC 1918 / RFC 4193)',
  LINK_LOCAL: 'link-local address, the cloud instance metadata range',
  UNSPECIFIED: 'unspecified address',
  MULTICAST: 'multicast address',
  RESERVED: 'reserved or special-use address',
  CARRIER_NAT: 'carrier-grade NAT address',
  UNIQUE_LOCAL: 'unique local address (RFC 4193)',
};

/**
 * Reasons that ALLOW_PRIVATE_TARGETS must never be able to unlock.
 *
 * The escape hatch exists so the fixture apps on 127.0.0.1 can be tested. No
 * fixture lives in the cloud metadata range, so extending the exemption to it
 * bought nothing and cost everything: with the flag on, a user-supplied
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` was
 * fetched by the server and its body returned to the caller. On a laptop that
 * fails to route; on App Runner it hands over the task role's credentials.
 *
 * config/env.js already refuses the flag when NODE_ENV=production, but that
 * check only covers the value read at boot: tests and the evaluation harness
 * set `env.ALLOW_PRIVATE_TARGETS` directly at runtime and bypass it entirely.
 * A rule that cannot be switched off is the only kind worth relying on here.
 */
export const NEVER_ALLOWED = new Set([BLOCK_REASONS.LINK_LOCAL]);

/** True when this verdict must hold even with ALLOW_PRIVATE_TARGETS on. */
export const isNeverAllowed = (verdict) =>
  Boolean(verdict?.blocked) && NEVER_ALLOWED.has(verdict.reason);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

const inCidr = (int, base, bits) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (int & mask) === (ipv4ToInt(base) & mask);
};

/** RFC 5735 / 6890 special-use ranges, plus RFC 1918 private space. */
const V4_RULES = [
  ['0.0.0.0', 8, BLOCK_REASONS.UNSPECIFIED],
  ['10.0.0.0', 8, BLOCK_REASONS.PRIVATE],
  ['100.64.0.0', 10, BLOCK_REASONS.CARRIER_NAT],
  ['127.0.0.0', 8, BLOCK_REASONS.LOOPBACK],
  ['169.254.0.0', 16, BLOCK_REASONS.LINK_LOCAL], // ← cloud metadata
  ['172.16.0.0', 12, BLOCK_REASONS.PRIVATE],
  ['192.0.0.0', 24, BLOCK_REASONS.RESERVED],
  ['192.0.2.0', 24, BLOCK_REASONS.RESERVED],
  ['192.88.99.0', 24, BLOCK_REASONS.RESERVED],
  ['192.168.0.0', 16, BLOCK_REASONS.PRIVATE],
  ['198.18.0.0', 15, BLOCK_REASONS.RESERVED],
  ['198.51.100.0', 24, BLOCK_REASONS.RESERVED],
  ['203.0.113.0', 24, BLOCK_REASONS.RESERVED],
  ['224.0.0.0', 4, BLOCK_REASONS.MULTICAST],
  ['240.0.0.0', 4, BLOCK_REASONS.RESERVED],
];

/**
 * Normalises an IPv6 address to full 8-group hex form so prefix comparison is
 * simple and total. Returns null if it cannot be parsed.
 */
export function expandIpv6(addr) {
  let s = addr.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.split('%')[0]; // strip zone index, e.g. fe80::1%eth0

  // An embedded IPv4 tail (::ffff:127.0.0.1) becomes two hex groups.
  const v4tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const int = ipv4ToInt(v4tail[1]);
    if (int === null) return null;
    const hi = ((int >>> 16) & 0xffff).toString(16);
    const lo = (int & 0xffff).toString(16);
    s = s.slice(0, v4tail.index) + `${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

/**
 * If the address is IPv4-mapped or IPv4-compatible IPv6, return the embedded
 * IPv4. `::ffff:127.0.0.1` is a classic guard bypass: it looks like IPv6 to a
 * naive check but routes to loopback.
 */
export function extractMappedIpv4(expanded) {
  if (!expanded) return null;
  const g = expanded.split(':');
  const isMapped = g.slice(0, 5).every((x) => x === '0000') && g[5] === 'ffff';

  // IPv4-COMPATIBLE (::a.b.c.d) is deprecated but still routable in places.
  // The low 32 bits must be > 1: :: is the unspecified address and ::1 is IPv6
  // loopback, and treating ::1 as "::0.0.0.1" would misreport loopback as
  // unspecified: wrong reason, and a sign the ordering is fragile.
  const low32 = (parseInt(g[6], 16) << 16) + parseInt(g[7], 16);
  const isCompat = g.slice(0, 6).every((x) => x === '0000') && low32 > 1;

  if (!isMapped && !isCompat) return null;
  const hi = parseInt(g[6], 16);
  const lo = parseInt(g[7], 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
}

function classifyV4(ip) {
  const int = ipv4ToInt(ip);
  if (int === null) return { blocked: true, reason: BLOCK_REASONS.RESERVED };
  if (ip === '255.255.255.255') return { blocked: true, reason: BLOCK_REASONS.RESERVED };
  for (const [base, bits, reason] of V4_RULES) {
    if (inCidr(int, base, bits)) return { blocked: true, reason };
  }
  return { blocked: false, reason: null };
}

function classifyV6(ip) {
  const expanded = expandIpv6(ip);
  if (!expanded) return { blocked: true, reason: BLOCK_REASONS.RESERVED };

  // The two singleton addresses are judged FIRST, before any IPv4 unwrapping,
  // so their reason is reported correctly rather than via a numeric coincidence.
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return { blocked: true, reason: BLOCK_REASONS.UNSPECIFIED };
  }
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return { blocked: true, reason: BLOCK_REASONS.LOOPBACK };
  }

  // Unwrap IPv4-mapped/compatible forms and judge them as IPv4.
  const mapped = extractMappedIpv4(expanded);
  if (mapped) return classifyV4(mapped);

  const first = parseInt(expanded.slice(0, 4), 16);
  if ((first & 0xfe00) === 0xfc00) return { blocked: true, reason: BLOCK_REASONS.UNIQUE_LOCAL }; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return { blocked: true, reason: BLOCK_REASONS.LINK_LOCAL };   // fe80::/10
  if ((first & 0xff00) === 0xff00) return { blocked: true, reason: BLOCK_REASONS.MULTICAST };    // ff00::/8

  return { blocked: false, reason: null };
}

/**
 * The security decision for a single resolved IP.
 * @returns {{ blocked: boolean, reason: string|null, family: 4|6|0 }}
 */
export function classifyIp(ip) {
  const family = isIP(ip);
  if (family === 0) return { blocked: true, reason: BLOCK_REASONS.RESERVED, family: 0 };
  const result = family === 4 ? classifyV4(ip) : classifyV6(ip);
  return { ...result, family };
}

export function isBlockedIp(ip) {
  return classifyIp(ip).blocked;
}

/**
 * Hostname suffixes that must never be resolved at all. These are mDNS/internal
 * namespaces; blocking by name is belt-and-braces alongside the IP check, since
 * a split-horizon resolver could map them to a public-looking address.
 */
export const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa'];
export const BLOCKED_HOSTNAMES = ['localhost', 'metadata.google.internal'];

export function isBlockedHostname(hostname) {
  const h = String(hostname).trim().toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.includes(h)) return true;
  return BLOCKED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}
