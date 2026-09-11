/**
 * probe_xss: reflected cross-site scripting.
 *
 * docs/01_PRD.md F3. The signal is a UNIQUE marker returned verbatim in an
 * HTML-ish response. Two details make this trustworthy:
 *
 *   - A per-invocation nonce, so a reflection is attributable to THIS probe
 *     rather than to content that happened to already be on the page.
 *   - A content-type check. Markup echoed into a JSON body is not a scripting
 *     vulnerability, and reporting it as one is a false positive that costs
 *     the reader's trust in every other finding.
 */
import { randomBytes } from 'node:crypto';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { probeInputSchema, probeOutputSchema } from './_probeSchema.js';
import { xssPayloads, isReflectedUnescaped, isHtmlish, bodyToText } from '../probes/fingerprints.js';
import {
  captureBaseline, describeBaseline, baselineIsBroken,
  makeFinding, cleanResult, SEVERITY,
} from '../probes/baseline.js';

export const inputSchema = probeInputSchema;
export const outputSchema = probeOutputSchema;

const FAMILY = 'xss';
const OWASP = 'API8:2023 Security Misconfiguration';

/** Puts the payload in each existing query param, or in `q` if there are none. */
export function reflectionTargets(rawUrl, payload) {
  const url = new URL(rawUrl);
  const keys = [...url.searchParams.keys()];
  const params = keys.length ? keys : ['q'];
  return params.map((key) => {
    const u = new URL(rawUrl);
    u.searchParams.set(key, payload);
    return { url: u.toString(), location: `query parameter "${key}"` };
  });
}

export default defineTool({
  name: 'probe_xss',
  title: 'Reflected XSS probe',
  description:
    'Send a uniquely marked reflection payload and check whether it is echoed unescaped ' +
    'into an HTML response. Detection only.',
  riskClass: RISK_CLASS.NETWORK_PROBE,
  inputSchema,
  outputSchema,

  async handler(input) {
    const { url, method, headers } = input;
    const nonce = randomBytes(4).toString('hex');

    let baselineRes;
    try {
      baselineRes = await fetchGuarded(url, { method, headers });
    } catch (err) {
      return { family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        error: `Baseline request failed: ${err.message}` };
    }
    const baseline = captureBaseline(baselineRes);
    if (baselineIsBroken(baseline)) {
      return { family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        note: `Baseline is already ${baseline.status}; no claim made.` };
    }

    const findings = [];
    let checked = 0;

    for (const payload of xssPayloads(nonce)) {
      for (const target of reflectionTargets(url, payload.value)) {
        checked += 1;
        let res;
        try {
          res = await fetchGuarded(target.url, { method, headers });
        } catch { continue; }

        const contentType = res.headers?.['content-type'];
        if (!isReflectedUnescaped(res.body, payload.value)) continue;

        // Reflected, but only dangerous where a browser will parse it as markup.
        if (!isHtmlish(contentType)) continue;

        const text = bodyToText(res.body);
        const at = text.indexOf(payload.value);
        findings.push(makeFinding({
          family: FAMILY, owasp: OWASP, severity: SEVERITY.HIGH, vulnerable: true,
          payload: `${payload.value}  (${target.location}, ${payload.label})`,
          signal:
            `The payload was returned verbatim in a ${contentType} response: ` +
            `"...${text.slice(Math.max(0, at - 30), at + payload.value.length + 30).trim()}..."`,
          baseline: `${describeBaseline(baseline)}: marker agentiq${nonce} absent before the probe.`,
          explanation:
            'User input is written into the HTML response without escaping, so an attacker who ' +
            'controls this parameter can execute script in a visitor\'s browser in your origin.',
          remediation:
            'HTML-escape all interpolated values (& < > " \'), or render through a template ' +
            'engine that escapes by default. Add a Content-Security-Policy as defence in depth.',
        }));
        break;
      }
    }

    return findings.length
      ? { family: FAMILY, owasp: OWASP, checked, findings }
      : { ...cleanResult(FAMILY, OWASP, checked) };
  },
});
