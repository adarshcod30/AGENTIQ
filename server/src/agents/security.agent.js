/**
 * SECURITY AGENT: docs/01_PRD.md F3.
 *
 * Runs the enabled probe families against one target, sequentially, and rolls
 * their findings up into one summary with an honest disclaimer.
 *
 * ⚠️ THIS FILE PERFORMS NO I/O. Guarded by tests/architecture.test.js.
 * Every request is made by an MCP tool: permission-checked, SSRF-guarded,
 * audited.
 *
 * EIGHT FAMILIES, seven of them tools. Rate limiting is orchestrated here from
 * repeated `http_request` calls rather than its own tool, because that would be
 * one more network tool, and every one of those requests is individually
 * audited anyway.
 */
import { SEVERITY } from '../mcp/probes/baseline.js';
import {
  makeFinding, correlateFindings, dedupeFindings, rankFindings, countBySeverity as countFindingsBySeverity,
  CONFIDENCE, LANE,
} from '../mcp/analysis/findings.js';

/** The eight families, in the order the UI shows them. */
export const FAMILIES = [
  { key: 'sqli', tool: 'probe_sqli', label: 'SQL injection', owasp: 'API8:2023 Security Misconfiguration' },
  { key: 'xss', tool: 'probe_xss', label: 'Reflected XSS', owasp: 'API8:2023 Security Misconfiguration' },
  { key: 'ssrf', tool: 'probe_ssrf', label: 'Server-side request forgery', owasp: 'API7:2023 Server-Side Request Forgery' },
  { key: 'redirect', tool: 'probe_redirect', label: 'Open redirect', owasp: 'API7:2023 Server-Side Request Forgery' },
  { key: 'auth', tool: 'probe_auth', label: 'Broken authentication', owasp: 'API2:2023 Broken Authentication' },
  { key: 'cors', tool: 'probe_cors', label: 'CORS misconfiguration', owasp: 'API8:2023 Security Misconfiguration' },
  { key: 'headers', tool: 'probe_headers', label: 'Security headers', owasp: 'API8:2023 Security Misconfiguration' },
  { key: 'rate', tool: null, label: 'Rate limiting', owasp: 'API4:2023 Unrestricted Resource Consumption' },
];

/** docs/02_TRD.md §7 caps outbound probe traffic at 5 req/s per host. */
export const RATE_PROBE_REQUESTS = 8;

/**
 * Rate-limit family.
 *
 * A finding requires ALL of: every request succeeded, no 429 appeared, and no
 * RateLimit/Retry-After header was advertised. Sending 8 requests and seeing 8
 * successes is not by itself proof of an absent limiter: a limit of 60/min
 * would also allow all 8, so the response headers carry most of the weight.
 * Severity is MEDIUM accordingly: this is an indicator, not a demonstration.
 */
export async function probeRateLimit({ url, method, headers, runTool, context }) {
  const responses = [];
  for (let i = 0; i < RATE_PROBE_REQUESTS; i += 1) {
    try {
      responses.push(await runTool('http_request', { url, method, headers }, context));
    } catch (err) {
      // A refusal by the egress rate limiter is OUR guard, not the target's.
      return {
        family: 'rate',
        owasp: 'API4:2023 Unrestricted Resource Consumption',
        checked: responses.length,
        findings: [],
        note: `Stopped after ${responses.length} requests: ${err.message}`,
      };
    }
  }

  const anyThrottled = responses.some((r) => r.status === 429);
  const advertises = responses.some((r) => {
    const h = r.headers ?? {};
    return h['ratelimit'] || h['ratelimit-limit'] || h['x-ratelimit-limit'] || h['retry-after'];
  });
  const allSucceeded = responses.every((r) => r.status >= 200 && r.status < 400);

  if (!anyThrottled && !advertises && allSucceeded) {
    return {
      family: 'rate',
      owasp: 'API4:2023 Unrestricted Resource Consumption',
      checked: responses.length,
      findings: [{
        family: 'rate',
        owasp: 'API4:2023 Unrestricted Resource Consumption',
        severity: SEVERITY.MEDIUM,
        vulnerable: true,
        payload: `${RATE_PROBE_REQUESTS} sequential ${method} requests to ${url}`,
        signal:
          `All ${responses.length} requests returned ${responses[0].status}. No 429, no ` +
          'Retry-After, and no RateLimit headers were advertised.',
        baseline:
          `A rate-limited endpoint advertises its budget (RateLimit-Limit) or eventually ` +
          `answers 429. Neither appeared across ${responses.length} requests.`,
        explanation:
          'No rate limiting is evident, so a client can call this endpoint as fast as it likes. ' +
          'That enables credential stuffing, scraping and resource exhaustion. Note this is an ' +
          'indicator: a generous limit would also permit this many requests.',
        remediation:
          'Apply a per-IP and per-account limit (express-rate-limit or an edge/WAF rule) and ' +
          'return standard RateLimit headers so clients can back off.',
      }],
    };
  }

  return {
    family: 'rate',
    owasp: 'API4:2023 Unrestricted Resource Consumption',
    checked: responses.length,
    findings: [],
    note: anyThrottled
      ? 'The endpoint returned 429: rate limiting is enforced.'
      : advertises
        ? 'The endpoint advertises RateLimit headers.'
        : 'Requests did not all succeed; no conclusion drawn.',
  };
}

/** Rolls per-severity counts up for the run summary. */
export function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  }
  return counts;
}

/**
 * Runs the enabled families against one target.
 *
 * @returns {{ families, findings, summary }}
 */
export async function runSecurityAgent({
  url,
  method = 'GET',
  headers = {},
  body,
  intendedPublic = false,
  families = FAMILIES.map((f) => f.key),
  runTool,
  context = {},
}) {
  const enabled = FAMILIES.filter((f) => families.includes(f.key));
  const results = [];

  for (const family of enabled) {
    // Families run sequentially. The egress guard rate-limits per host anyway,
    // and a scan that hammers a target the user nominated is exactly the
    // behaviour docs/01_PRD.md F3 forbids.
    try {
      if (family.key === 'rate') {
        results.push(await probeRateLimit({ url, method, headers, runTool, context }));
        continue;
      }

      const outcome = await runTool(family.tool, {
        url, method, headers, ...(body === undefined ? {} : { body }), intendedPublic,
      }, context);

      results.push({
        family: family.key,
        owasp: family.owasp,
        checked: outcome.checked ?? 0,
        findings: outcome.findings ?? [],
        note: outcome.note,
        error: outcome.error,
      });
    } catch (err) {
      // One family failing must not abandon the scan
      // (docs/03_App_Flow.md Part C: "Per-family error, others continue").
      results.push({
        family: family.key,
        owasp: family.owasp,
        checked: 0,
        findings: [],
        error: err.message,
      });
    }
  }

  const findings = results.flatMap((r) => r.findings);

  return {
    families: results,
    findings,
    summary: {
      familiesRun: results.length,
      familiesClean: results.filter((r) => r.findings.length === 0 && !r.error).length,
      familiesErrored: results.filter((r) => r.error).length,
      totalFindings: findings.length,
      bySeverity: countBySeverity(findings),
      /**
       * The honest disclosure required by docs/03_App_Flow.md B2. A clean
       * result is a designed state with this sentence attached, never an
       * empty list presented as proof of safety.
       */
      disclaimer:
        `${results.length} checks run, ${findings.length} indicator(s) found. This is not a ` +
        'guarantee of security. See About for what is and is not covered.',
    },
  };
}

// ── Static lanes and the unified assessment (Phase 3) ────────────────────────

/** Maps a DAST probe finding onto the shared finding shape. */
export function dastToFinding(probeFinding, { endpoint = null } = {}) {
  return makeFinding({
    lane: LANE.DAST,
    category: probeFinding.family,
    owasp: probeFinding.owasp ?? null,
    severity: probeFinding.severity,
    // A probe demonstrated it against the running app: this is the confirmed end
    // of the confidence ladder, the counterweight to a static lead.
    confidence: CONFIDENCE.CONFIRMED,
    title: probeFinding.explanation?.split('.')[0] ?? probeFinding.family,
    description: probeFinding.explanation ?? '',
    evidence: [probeFinding.payload, probeFinding.signal].filter(Boolean).join(' -> '),
    remediation: probeFinding.remediation ?? '',
    location: { endpoint },
  });
}

/** The four static tools that need no running app. Runs them, collects findings. */
export async function runStaticSecurity({ runTool, context = {} }) {
  const lanes = ['secret_scan', 'sast_scan', 'config_scan', 'dep_audit'];
  const findings = [];
  const notes = [];
  for (const tool of lanes) {
    try {
      const out = await runTool(tool, {}, context);
      if (out.findings?.length) findings.push(...out.findings);
      if (out.note) notes.push(`${tool}: ${out.note}`);
    } catch (err) {
      notes.push(`${tool} failed: ${err.message}`);
    }
  }
  return { findings, notes };
}

/**
 * The full security assessment: the dynamic probes against the running app AND
 * the static lanes against the workspace, mapped to one shape, de-duplicated and
 * correlated so a static lead and a dynamic proof about the same route become
 * one finding. docs/10_AUTONOMOUS_PLATFORM.md §D.
 */
export async function runSecurityAssessment({
  url, method = 'GET', headers = {}, body, intendedPublic = false,
  families = FAMILIES.map((f) => f.key), runStatic = true, runTool, context = {},
}) {
  const endpointLabel = url ? `${method} ${new URL(url).pathname}` : null;

  const dast = url
    ? await runSecurityAgent({ url, method, headers, body, intendedPublic, families, runTool, context })
    : { findings: [], families: [], summary: null };
  const dastFindings = dast.findings.map((f) => dastToFinding(f, { endpoint: endpointLabel }));

  const staticResult = runStatic
    ? await runStaticSecurity({ runTool, context })
    : { findings: [], notes: [] };

  const all = correlateFindings(dedupeFindings([...dastFindings, ...staticResult.findings]));
  const findings = rankFindings(all);

  return {
    findings,
    dast: dast.families,
    notes: staticResult.notes,
    summary: {
      total: findings.length,
      bySeverity: countFindingsBySeverity(findings),
      lanes: {
        dast: dastFindings.length,
        static: staticResult.findings.length,
      },
      disclaimer:
        `${findings.length} finding(s) after correlating dynamic probes and static analysis. `
        + 'This is not a guarantee of security. See About for what is and is not covered.',
    },
  };
}

export default runSecurityAgent;
