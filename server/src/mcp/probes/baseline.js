/**
 * Baseline differential: the false-positive control.
 *
 * docs/01_PRD.md F3: "Every probe first sends a benign request and stores the
 * baseline (status, length, content-type, timing band). A finding requires a
 * MATERIAL DEVIATION from baseline, not an absolute condition."
 *
 * An endpoint that returns 500 for everything, including a completely benign
 * request, is broken, not injectable. Reporting it as a vulnerability is the
 * kind of finding that destroys trust in every other finding.
 *
 * The comparison is deliberately conservative. When the baseline and the
 * payload response are indistinguishable, the correct answer is "no evidence",
 * not "probably vulnerable".
 */

/** Timing buckets. Absolute milliseconds are far too noisy to compare. */
export function timingBand(ms) {
  if (ms < 100) return 'fast';
  if (ms < 500) return 'normal';
  if (ms < 2000) return 'slow';
  return 'very-slow';
}

/**
 * Captures a benign response as a comparable fingerprint.
 * Called before every probe, using the SAME method and headers the probe uses.
 */
export function captureBaseline(response) {
  const body = response?.body ?? '';
  return {
    status: response?.status ?? 0,
    length: typeof body === 'string' ? body.length : JSON.stringify(body ?? '').length,
    contentType: String(response?.headers?.['content-type'] ?? '').split(';')[0].trim(),
    timingBand: timingBand(response?.durationMs ?? 0),
    durationMs: response?.durationMs ?? 0,
  };
}

/** Human-readable one-liner for the finding's BASELINE field. */
export function describeBaseline(b) {
  return `${b.status}, ${b.length} bytes, ${b.contentType || 'unknown type'}, ${b.timingBand} (${b.durationMs}ms)`;
}

/**
 * Compares a probe response against the baseline.
 *
 * `material` is true only when something changed that a defect could plausibly
 * explain. Length alone is not material: a response echoing a longer input is
 * naturally longer, and treating that as a signal would flag every endpoint
 * that reflects a parameter.
 */
export function compare(baseline, response) {
  const probe = captureBaseline(response);

  const statusChanged = probe.status !== baseline.status;
  const becameError = probe.status >= 500 && baseline.status < 500;
  const typeChanged = probe.contentType !== baseline.contentType;

  // Proportional, so a 12-byte change on a 4KB body is not "a big difference".
  const lengthDelta = Math.abs(probe.length - baseline.length);
  const lengthRatio = baseline.length > 0 ? lengthDelta / baseline.length : (probe.length > 0 ? 1 : 0);
  const lengthChangedMaterially = lengthRatio > 0.25 && lengthDelta > 64;

  return {
    baseline,
    probe,
    statusChanged,
    becameError,
    typeChanged,
    lengthDelta,
    lengthRatio,
    lengthChangedMaterially,
    // Deliberately excludes bare length change: reflection makes bodies longer.
    material: statusChanged || typeChanged || becameError,
    summary:
      `baseline ${baseline.status}/${baseline.length}B/${baseline.timingBand} → ` +
      `probe ${probe.status}/${probe.length}B/${probe.timingBand}`,
  };
}

/**
 * True when the endpoint is broken regardless of input: 5xx on a BENIGN
 * request. Probes must not report anything as a vulnerability in this state:
 * every payload will also produce a 500 and every family would fire at once.
 */
export function baselineIsBroken(baseline) {
  return baseline.status >= 500 || baseline.status === 0;
}

export const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

/**
 * Builds a finding. Every field is mandatory by design.
 *
 * docs/03_App_Flow.md B2: "A finding with no payload and no baseline is not a
 * finding. Show the evidence or do not make the claim."
 */
export function makeFinding({
  family, owasp, severity, vulnerable,
  payload = null, signal = null, baseline = null,
  explanation, remediation,
}) {
  return {
    family, owasp, severity, vulnerable,
    payload, signal, baseline,
    explanation, remediation,
  };
}

/** A clean result for a family: checked, nothing found. Not an empty list. */
export function cleanResult(family, owasp, checked) {
  return {
    family,
    owasp,
    checked,
    findings: [],
  };
}
