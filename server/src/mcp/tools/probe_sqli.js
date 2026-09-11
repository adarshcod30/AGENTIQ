/**
 * probe_sqli: SQL injection indicators.
 *
 * docs/01_PRD.md F3. Two independent signals, either of which is evidence:
 *
 *   1. A database error fingerprint appears that was NOT in the baseline.
 *   2. The response deviates materially from the benign baseline in a way a
 *      SQL parser error would explain.
 *
 * WHAT THIS GETS RIGHT
 *   - A 500 is a signal only if the benign baseline was NOT already 500.
 *     Treating any 500 as SQL injection flags every broken endpoint.
 *   - The whole body is serialised before matching. Checking only string
 *     bodies makes every JSON API invisible.
 *   - Every payload runs. Returning after the first silently skips the rest.
 *
 * SAFETY: read-only payloads only. No DROP, DELETE, UPDATE or stacked
 * statements: docs/01_PRD.md F3 makes detection-only a hard ethical boundary.
 */
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { probeInputSchema, probeOutputSchema } from './_probeSchema.js';
import { findDbError, SQLI_PAYLOADS } from '../probes/fingerprints.js';
import {
  captureBaseline, compare, describeBaseline, baselineIsBroken,
  makeFinding, cleanResult, SEVERITY,
} from '../probes/baseline.js';

export const inputSchema = probeInputSchema;
export const outputSchema = probeOutputSchema;

const FAMILY = 'sqli';
const OWASP = 'API8:2023 Security Misconfiguration';

/** Appends the payload to the URL's last path segment and to a query param. */
export function injectionTargets(rawUrl, payload) {
  const url = new URL(rawUrl);
  const targets = [];

  // Query parameter injection: the most common shape.
  if ([...url.searchParams.keys()].length > 0) {
    for (const key of [...url.searchParams.keys()]) {
      const u = new URL(rawUrl);
      u.searchParams.set(key, payload);
      targets.push({ url: u.toString(), location: `query parameter "${key}"` });
    }
  } else {
    const u = new URL(rawUrl);
    u.searchParams.set('id', payload);
    targets.push({ url: u.toString(), location: 'query parameter "id"' });
  }

  // Path-segment injection, when the last segment looks like an identifier.
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 0 && /^[\w-]+$/.test(segments.at(-1))) {
    const u = new URL(rawUrl);
    u.pathname = [...segments.slice(0, -1), encodeURIComponent(payload)].join('/');
    if (!u.pathname.startsWith('/')) u.pathname = `/${u.pathname}`;
    targets.push({ url: u.toString(), location: 'final path segment' });
  }

  return targets;
}

export default defineTool({
  name: 'probe_sqli',
  title: 'SQL injection probe',
  description:
    'Send read-only SQL-injection indicator payloads and fingerprint database errors ' +
    'against a benign baseline. Detection only, never modifies data.',
  riskClass: RISK_CLASS.NETWORK_PROBE,
  inputSchema,
  outputSchema,

  async handler(input) {
    const { url, method, headers } = input;

    // ── Baseline first, always ────────────────────────────────────────────
    let baselineRes;
    try {
      baselineRes = await fetchGuarded(url, { method, headers });
    } catch (err) {
      return { family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        error: `Baseline request failed: ${err.message}` };
    }
    const baseline = captureBaseline(baselineRes);
    const baselineDbError = findDbError(baselineRes.body);

    // An endpoint that 500s on benign input is broken, not injectable. Every
    // payload would also 500, and reporting that would be a false positive.
    if (baselineIsBroken(baseline)) {
      return {
        family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        note: `Baseline is already ${baseline.status}; cannot distinguish an injection ` +
              'from an endpoint that fails on benign input. No claim made.',
      };
    }

    const findings = [];
    let checked = 0;

    for (const payload of SQLI_PAYLOADS) {
      for (const target of injectionTargets(url, payload.value)) {
        checked += 1;
        let res;
        try {
          res = await fetchGuarded(target.url, { method, headers });
        } catch {
          continue; // transport failure is not evidence of a vulnerability
        }

        const diff = compare(baseline, res);
        const dbError = findDbError(res.body);

        // SIGNAL 1: a database error that the baseline did not produce.
        if (dbError.found && !baselineDbError.found) {
          findings.push(makeFinding({
            family: FAMILY, owasp: OWASP, severity: SEVERITY.HIGH, vulnerable: true,
            payload: `${payload.value}  (${target.location})`,
            signal: `Response contained a ${dbError.engine} error fingerprint: "${dbError.excerpt}"`,
            baseline: `${describeBaseline(baseline)}: no database error. ${diff.summary}`,
            explanation:
              `Input appears to be concatenated into a SQL statement rather than passed as a ` +
              `parameter. The ${dbError.engine} driver error reached the response body, which ` +
              'also tells an attacker which database you run.',
            remediation:
              'Use parameterised queries or prepared statements, and never build SQL by string ' +
              'concatenation. Return a generic error body; never surface driver messages.',
          }));
          break; // one confirmed finding per payload is enough
        }

        // SIGNAL 2: a material deviation a parser error would explain.
        // Requires becameError specifically: a mere status change (404 for a
        // nonsense id, say) is normal, correct behaviour.
        if (diff.becameError && !baselineDbError.found) {
          findings.push(makeFinding({
            family: FAMILY, owasp: OWASP, severity: SEVERITY.MEDIUM, vulnerable: true,
            payload: `${payload.value}  (${target.location})`,
            signal:
              `Benign request returned ${baseline.status}; the payload returned ` +
              `${diff.probe.status}. The input reaches something that fails on a quote.`,
            baseline: `${describeBaseline(baseline)}. ${diff.summary}`,
            explanation:
              'A SQL metacharacter changed a working request into a server error, which ' +
              'suggests the value is interpolated into a query. No driver error was leaked, ' +
              'so this is an indicator rather than a confirmation.',
            remediation:
              'Use parameterised queries. Validate and type-check the parameter before use.',
          }));
          break;
        }
      }
    }

    return findings.length
      ? { family: FAMILY, owasp: OWASP, checked, findings }
      : { ...cleanResult(FAMILY, OWASP, checked) };
  },
});
