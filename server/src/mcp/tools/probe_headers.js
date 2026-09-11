/**
 * probe_headers: missing security headers.
 *
 * docs/01_PRD.md F3: HSTS, CSP, X-Content-Type-Options, X-Frame-Options.
 *
 * Severity is deliberately calibrated. A missing header is a hardening gap,
 * not a breach: reporting all four as HIGH would drown a real SQL injection in
 * noise, and a reader who learns to skim your findings will skim the one that
 * mattered. Each is scored by what its absence actually enables.
 *
 * Risk class network.read: one ordinary request, no payload.
 */
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { probeInputSchema, probeOutputSchema } from './_probeSchema.js';
import { makeFinding, cleanResult, SEVERITY } from '../probes/baseline.js';

export const inputSchema = probeInputSchema;
export const outputSchema = probeOutputSchema;

const FAMILY = 'headers';
const OWASP = 'API8:2023 Security Misconfiguration';

export const EXPECTED_HEADERS = [
  {
    name: 'strict-transport-security',
    label: 'Strict-Transport-Security (HSTS)',
    severity: SEVERITY.MEDIUM,
    explanation:
      'Without HSTS a browser will try plain HTTP first, so an attacker on the network can ' +
      'downgrade the connection and read or alter traffic before the redirect happens.',
    remediation: 'Send `Strict-Transport-Security: max-age=31536000; includeSubDomains`.',
    httpsOnly: true,
  },
  {
    name: 'content-security-policy',
    label: 'Content-Security-Policy',
    severity: SEVERITY.MEDIUM,
    explanation:
      'CSP is the main defence-in-depth control against cross-site scripting. Without it, any ' +
      'reflected or stored XSS runs with no further obstacle.',
    remediation: "Start with `Content-Security-Policy: default-src 'self'` and tighten from there.",
  },
  {
    name: 'x-content-type-options',
    label: 'X-Content-Type-Options',
    severity: SEVERITY.LOW,
    explanation:
      'Without `nosniff` a browser may ignore the declared Content-Type and guess, so a JSON ' +
      'response containing markup can be executed as HTML.',
    remediation: 'Send `X-Content-Type-Options: nosniff`.',
  },
  {
    name: 'x-frame-options',
    label: 'X-Frame-Options',
    severity: SEVERITY.LOW,
    explanation:
      'Without it the response can be framed by another site, enabling clickjacking against ' +
      'any interactive content.',
    remediation: 'Send `X-Frame-Options: DENY`, or `frame-ancestors` in your CSP.',
  },
];

export default defineTool({
  name: 'probe_headers',
  title: 'Security headers probe',
  description:
    'Check for HSTS, Content-Security-Policy, X-Content-Type-Options and X-Frame-Options, ' +
    'and for a server banner that leaks the stack.',
  riskClass: RISK_CLASS.NETWORK_READ,
  inputSchema,
  outputSchema,

  async handler(input) {
    const { url, method, headers } = input;

    let res;
    try {
      res = await fetchGuarded(url, { method, headers });
    } catch (err) {
      return { family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        error: `Request failed: ${err.message}` };
    }

    const isHttps = new URL(url).protocol === 'https:';
    const present = Object.keys(res.headers ?? {}).map((h) => h.toLowerCase());
    const findings = [];

    for (const header of EXPECTED_HEADERS) {
      // HSTS over plain http is meaningless: a browser ignores it entirely.
      // Reporting it on an http:// target would be a false positive.
      if (header.httpsOnly && !isHttps) continue;
      if (present.includes(header.name)) continue;

      findings.push(makeFinding({
        family: FAMILY, owasp: OWASP, severity: header.severity, vulnerable: true,
        payload: `${method} ${url}  (ordinary request, no payload)`,
        signal: `Response headers did not include ${header.label}.`,
        baseline: `Headers returned: ${present.length ? present.join(', ') : '(none)'}`,
        explanation: header.explanation,
        remediation: header.remediation,
      }));
    }

    // A version banner is information disclosure rather than a control gap.
    const poweredBy = res.headers?.['x-powered-by'];
    if (poweredBy) {
      findings.push(makeFinding({
        family: FAMILY, owasp: OWASP, severity: SEVERITY.LOW, vulnerable: true,
        payload: `${method} ${url}`,
        signal: `X-Powered-By: ${poweredBy}`,
        baseline: 'A hardened server does not advertise its stack.',
        explanation:
          'The response names the framework running the service, which lets an attacker go ' +
          'straight to known vulnerabilities for that stack and version.',
        remediation: 'Disable the banner: in Express, `app.disable("x-powered-by")` or helmet.',
      }));
    }

    const checked = EXPECTED_HEADERS.length + 1;
    return findings.length
      ? { family: FAMILY, owasp: OWASP, checked, findings }
      : { ...cleanResult(FAMILY, OWASP, checked), note: 'All expected security headers present.' };
  },
});
