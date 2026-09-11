/**
 * The one security-finding shape, shared by every lane.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D. The DAST probes (Phase 1 of the security
 * agent) and the static lanes (Phase 3: dependencies, secrets, source, config)
 * describe very different evidence, but a reader wants one list. Every lane maps
 * to this shape, so the report treats them uniformly, and correlation can merge
 * a static and a dynamic finding about the same thing into one.
 */

export const SEVERITY = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low', INFO: 'info' };
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** The confidence ladder from the plan: a demonstrated issue outranks a hunch. */
export const CONFIDENCE = {
  CONFIRMED: 'confirmed',        // a probe demonstrated it
  STRONG: 'strong',              // a static signal with corroboration
  POTENTIAL: 'potential',        // a single static signal
  INFORMATIONAL: 'informational',
};
const CONFIDENCE_RANK = { confirmed: 3, strong: 2, potential: 1, informational: 0 };

export const LANE = { DAST: 'dast', DEPS: 'deps', SECRETS: 'secrets', SAST: 'sast', CONFIG: 'config' };

/** Builds a finding with sane defaults and a trimmed evidence string. */
export function makeFinding({
  lane, category, severity, confidence, title, description = '',
  evidence = '', remediation = '', owasp = null, location = {},
}) {
  return {
    lane,
    category,
    severity,
    confidence,
    title,
    description,
    evidence: String(evidence).slice(0, 600),
    remediation,
    owasp,
    location: {
      file: location.file ?? null,
      line: location.line ?? null,
      endpoint: location.endpoint ?? null,
    },
  };
}

export const higherSeverity = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);
export const higherConfidence = (a, b) => (CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b);

/** A key for "the same finding": lane, category and where it is. */
function dedupeKey(f) {
  return [f.lane, f.category, f.location.file ?? '', f.location.line ?? '', f.location.endpoint ?? ''].join('|');
}

/** Collapses exact duplicates within a lane, keeping the strongest. */
export function dedupeFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    const k = dedupeKey(f);
    const prior = byKey.get(k);
    if (!prior) { byKey.set(k, f); continue; }
    byKey.set(k, {
      ...prior,
      severity: higherSeverity(prior.severity, f.severity),
      confidence: higherConfidence(prior.confidence, f.confidence),
    });
  }
  return [...byKey.values()];
}

/**
 * Correlates across lanes: a static finding and a dynamic finding about the same
 * category at the same endpoint become one, with both pieces of evidence and the
 * stronger severity and confidence. A DAST-confirmed auth bypass corroborated by
 * a SAST missing-authorization on the same route is one finding, not two.
 */
export function correlateFindings(findings) {
  const groups = new Map(); // category + endpoint (when both present)
  const standalone = [];
  for (const f of findings) {
    const endpoint = f.location.endpoint;
    if (!endpoint) { standalone.push(f); continue; }
    const k = `${f.category}|${endpoint}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }

  const merged = [];
  for (const group of groups.values()) {
    if (group.length === 1) { merged.push(group[0]); continue; }
    const lanes = [...new Set(group.map((f) => f.lane))];
    const base = group.reduce((a, b) => ({
      ...a,
      severity: higherSeverity(a.severity, b.severity),
      confidence: higherConfidence(a.confidence, b.confidence),
    }));
    merged.push({
      ...base,
      lane: lanes.join('+'),
      evidence: group.map((f) => `[${f.lane}] ${f.evidence}`).join(' | ').slice(0, 900),
      description: base.description,
      correlatedFrom: lanes,
    });
  }
  return [...merged, ...standalone];
}

/** Rolls findings up to per-severity counts, for a summary. */
export function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  return counts;
}

/** Sorts most severe, then most confident, first. */
export function rankFindings(findings) {
  return [...findings].sort((a, b) => (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
  ));
}
