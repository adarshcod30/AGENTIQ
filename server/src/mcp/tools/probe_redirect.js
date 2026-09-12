/**
 * probe_redirect: open redirect.
 *
 * A redirect parameter that will send the browser to ANY host, not just back
 * into the site, is an open redirect. On its own it powers convincing phishing
 * links (the URL really is on your domain, right up until the jump), and it is
 * the usual final step in stealing an OAuth token, so it is worth its own check.
 *
 * The signal is unambiguous: we inject a unique off-site canary as the
 * destination and read the Location header WITHOUT following it. A relative
 * Location resolves back to the target's own host and is fine. Only a 3xx that
 * points at our canary host counts, which is why this never fires on the normal
 * same-site redirect a login flow performs.
 *
 * Risk class network.read: the request itself is benign, an ordinary GET with a
 * URL in a parameter, and it only reads where the server says it would send us.
 */
import { randomBytes } from 'node:crypto';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { probeInputSchema, probeOutputSchema } from './_probeSchema.js';
import { makeFinding, cleanResult, SEVERITY } from '../probes/baseline.js';
import {
  REDIRECT_PARAM_NAMES, urlParamTargets, withParam, redirectCanary, isOpenRedirect,
} from '../probes/ssrfRedirect.js';

export const inputSchema = probeInputSchema;
export const outputSchema = probeOutputSchema;

const FAMILY = 'redirect';
const OWASP = 'API7:2023 Server-Side Request Forgery';

export default defineTool({
  name: 'probe_redirect',
  title: 'Open redirect probe',
  description:
    'Inject an off-site destination into a redirect parameter and check whether the server sends ' +
    'the browser there. Reads the Location header without following it. Detection only.',
  riskClass: RISK_CLASS.NETWORK_READ,
  inputSchema,
  outputSchema,

  async handler(input) {
    const { url, method, headers } = input;
    const nonce = randomBytes(4).toString('hex');
    const canary = redirectCanary(nonce);

    const params = urlParamTargets(url, {
      names: REDIRECT_PARAM_NAMES,
      fallback: ['redirect', 'next', 'url', 'return'],
    });

    const findings = [];
    let checked = 0;

    for (const key of params) {
      checked += 1;
      const target = withParam(url, key, canary);
      let res;
      try {
        // followRedirects:false so we read the Location the target sets rather
        // than chasing it to a canary host that does not resolve.
        res = await fetchGuarded(target, { method, headers, followRedirects: false });
      } catch { continue; }

      const verdict = isOpenRedirect({ status: res.status, location: res.headers?.location, requestUrl: target });
      if (!verdict.vulnerable) continue;

      findings.push(makeFinding({
        family: FAMILY, owasp: OWASP, severity: SEVERITY.MEDIUM, vulnerable: true,
        payload: `${key}=${canary}`,
        signal: `Responded ${res.status} with Location: ${verdict.to}, an off-site host we supplied.`,
        baseline:
          'A safe redirect only sends the browser to a path inside the site, so a relative Location ' +
          'or a rejected request. This one echoed our arbitrary destination.',
        explanation:
          'The redirect target is taken from user input without checking that it stays on this site, ' +
          'so a link to your domain can bounce a visitor straight to an attacker\'s page. It reads as ' +
          'trustworthy because the visible URL really is yours, and it is the classic last hop for ' +
          'stealing an OAuth authorization code.',
        remediation:
          'Do not put a full URL in the redirect parameter. Redirect only to a fixed allow-list of ' +
          'paths, or to relative paths that begin with a single "/" (reject "//" and absolute URLs). ' +
          'If an absolute URL is unavoidable, check its host against an allow-list before redirecting.',
      }));
      // One parameter proving it is enough.
      break;
    }

    return findings.length
      ? { family: FAMILY, owasp: OWASP, checked, findings }
      : { ...cleanResult(FAMILY, OWASP, checked),
        note: 'No redirect parameter sent the browser off-site.' };
  },
});
