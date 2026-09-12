/**
 * probe_ssrf: server-side request forgery (OWASP API7:2023).
 *
 * Points a URL-shaped parameter at somewhere the server should never reach on a
 * client's behalf, the cloud metadata endpoint above all, and reads the reply
 * for proof the server actually went there. Two signals, both tied to evidence:
 *
 *   - metadata CONTENT in the body (the credentials-leaking case), or
 *   - the host we injected echoed beside a real server-side socket error, which
 *     proves the parameter opens a connection even when this target refused.
 *
 * Detection only: no payload rewrites data, and the canaries are unreachable by
 * construction. Risk class network.probe, because supplying an internal-range
 * URL to a target is exactly the attack-indicator traffic that class exists to
 * gate. The request AGENTIQ itself makes still goes through the egress guard, so
 * the probe cannot become an SSRF vector in its own right.
 */
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { probeInputSchema, probeOutputSchema } from './_probeSchema.js';
import {
  captureBaseline, describeBaseline, baselineIsBroken,
  makeFinding, cleanResult,
} from '../probes/baseline.js';
import {
  SSRF_PARAM_NAMES, SSRF_CANARIES, urlParamTargets, withParam, detectSsrf,
} from '../probes/ssrfRedirect.js';

export const inputSchema = probeInputSchema;
export const outputSchema = probeOutputSchema;

const FAMILY = 'ssrf';
const OWASP = 'API7:2023 Server-Side Request Forgery';

export default defineTool({
  name: 'probe_ssrf',
  title: 'Server-side request forgery probe',
  description:
    'Point a URL-shaped parameter at the cloud metadata endpoint and an internal address, and ' +
    'check whether the server fetches it on your behalf. Detection only.',
  riskClass: RISK_CLASS.NETWORK_PROBE,
  inputSchema,
  outputSchema,

  async handler(input) {
    const { url, method, headers } = input;

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

    const params = urlParamTargets(url, { names: SSRF_PARAM_NAMES, fallback: ['url'] });
    const findings = [];
    let checked = 0;

    for (const key of params) {
      for (const canary of SSRF_CANARIES) {
        checked += 1;
        let res;
        try {
          res = await fetchGuarded(withParam(url, key, canary.value), { method, headers });
        } catch { continue; }

        const verdict = detectSsrf(res.body, canary);
        if (!verdict.vulnerable) continue;

        findings.push(makeFinding({
          family: FAMILY, owasp: OWASP, severity: verdict.severity, vulnerable: true,
          payload: `${key}=${canary.value}  (${canary.label})`,
          signal: verdict.signal,
          baseline: `${describeBaseline(baseline)}: benign request revealed no internal content.`,
          explanation:
            verdict.kind === 'metadata'
              ? 'The server fetched an internal metadata address supplied through this parameter and ' +
                'returned its content. On a cloud host this hands out the instance\'s IAM credentials, ' +
                'and it lets an attacker reach any service on the internal network.'
              : 'The server makes a request to a URL supplied through this parameter, so an attacker ' +
                'can steer it at internal services, cloud metadata, or the loopback interface that ' +
                'a firewall was trusting to be unreachable from outside.',
          remediation:
            'Do not fetch arbitrary user-supplied URLs. Accept an ID or a fixed choice instead of a ' +
            'full URL, resolve and validate the host against an allow-list, block private, loopback ' +
            'and link-local ranges (including after DNS resolution), and disable unused URL schemes.',
        }));
        // One confirmed finding per parameter is enough evidence.
        break;
      }
    }

    return findings.length
      ? { family: FAMILY, owasp: OWASP, checked, findings }
      : { ...cleanResult(FAMILY, OWASP, checked),
        note: 'No parameter fetched an injected internal URL.' };
  },
});
