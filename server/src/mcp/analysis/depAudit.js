/**
 * Dependency audit: normalise `npm audit --json` into findings.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §7. The tool (dep_audit) spawns `npm audit`;
 * this pure parser turns its JSON into the shared finding shape, so it can be
 * tested against a captured sample with no network and no npm.
 */
import { makeFinding, SEVERITY, CONFIDENCE, LANE } from './findings.js';

/** npm severities map onto ours (npm uses "moderate" for our "medium"). */
const SEVERITY_MAP = {
  critical: SEVERITY.CRITICAL, high: SEVERITY.HIGH, moderate: SEVERITY.MEDIUM,
  low: SEVERITY.LOW, info: SEVERITY.INFO,
};

/** Renders fixAvailable (which can be a boolean or an object) as advice. */
function fixAdvice(fixAvailable) {
  if (fixAvailable === true) return 'Run `npm audit fix`.';
  if (fixAvailable && typeof fixAvailable === 'object') {
    const via = fixAvailable.name ? ` (updates ${fixAvailable.name}` + (fixAvailable.version ? ` to ${fixAvailable.version})` : ')') : '';
    return `A fix is available${via}, possibly a breaking change: review, then update.`;
  }
  return 'No automatic fix; check the advisory for a patched version or an alternative package.';
}

/**
 * Parses `npm audit --json` (npm 7+). Returns { findings, summary }.
 * Tolerant of a missing or malformed object: an empty result, not a throw.
 */
export function parseNpmAudit(audit) {
  const vulns = audit?.vulnerabilities ?? {};
  const findings = [];
  for (const [name, v] of Object.entries(vulns)) {
    const severity = SEVERITY_MAP[v.severity] ?? SEVERITY.INFO;
    const advisories = (Array.isArray(v.via) ? v.via : [])
      .filter((x) => x && typeof x === 'object')
      .map((x) => x.title)
      .filter(Boolean);
    findings.push(makeFinding({
      lane: LANE.DEPS,
      category: 'vulnerable-dependency',
      severity,
      confidence: CONFIDENCE.STRONG,
      title: `${name}: ${v.severity} severity advisory`,
      description: advisories.length
        ? advisories.slice(0, 3).join('; ')
        : `The installed range ${v.range ?? ''} of ${name} has a known advisory.`,
      evidence: `${name} ${v.range ?? ''}`.trim(),
      remediation: fixAdvice(v.fixAvailable),
      location: { file: 'package.json' },
    }));
  }
  const meta = audit?.metadata?.vulnerabilities ?? {};
  return {
    findings,
    summary: {
      total: meta.total ?? findings.length,
      critical: meta.critical ?? 0,
      high: meta.high ?? 0,
      moderate: meta.moderate ?? 0,
      low: meta.low ?? 0,
    },
  };
}
