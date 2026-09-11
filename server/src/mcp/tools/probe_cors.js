/**
 * probe_cors: CORS misconfiguration.
 *
 * docs/01_PRD.md F3. Two genuinely dangerous shapes:
 *
 *   1. `Access-Control-Allow-Origin: *` together with
 *      `Access-Control-Allow-Credentials: true`. Browsers reject this
 *      combination, but servers that send it usually reflect the origin
 *      instead when a real one is present, which is shape 2.
 *   2. Origin reflection: the server echoes ANY origin back with credentials
 *      allowed, so any site can read authenticated responses.
 *
 * Risk class is network.read, not network.probe: this sends an ordinary
 * request with an Origin header and reads the response. No attack payload is
 * involved, so demanding probe consent for it would be security theatre.
 */
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { probeInputSchema, probeOutputSchema } from './_probeSchema.js';
import { makeFinding, cleanResult, SEVERITY } from '../probes/baseline.js';

export const inputSchema = probeInputSchema;
export const outputSchema = probeOutputSchema;

const FAMILY = 'cors';
const OWASP = 'API8:2023 Security Misconfiguration';

/** An origin the target cannot plausibly have allow-listed on purpose. */
export const PROBE_ORIGIN = 'https://agentiq-cors-probe.example';

export default defineTool({
  name: 'probe_cors',
  title: 'CORS misconfiguration probe',
  description:
    'Inspect the CORS policy for a wildcard origin combined with credentials, or for ' +
    'reflection of an arbitrary origin.',
  riskClass: RISK_CLASS.NETWORK_READ,
  inputSchema,
  outputSchema,

  async handler(input) {
    const { url, method, headers } = input;

    let res;
    try {
      res = await fetchGuarded(url, {
        method,
        headers: { ...headers, origin: PROBE_ORIGIN },
      });
    } catch (err) {
      return { family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        error: `Request failed: ${err.message}` };
    }

    const acao = res.headers?.['access-control-allow-origin'];
    const acac = String(res.headers?.['access-control-allow-credentials'] ?? '').toLowerCase();
    const credentialsAllowed = acac === 'true';
    const findings = [];

    const evidence = `Access-Control-Allow-Origin: ${acao ?? '(absent)'} · ` +
      `Access-Control-Allow-Credentials: ${acac || '(absent)'}`;

    if (acao === '*' && credentialsAllowed) {
      findings.push(makeFinding({
        family: FAMILY, owasp: OWASP, severity: SEVERITY.HIGH, vulnerable: true,
        payload: `Origin: ${PROBE_ORIGIN}`,
        signal: evidence,
        baseline: 'A correct configuration sends either a specific origin with credentials, or ' +
                  '`*` without them, never both.',
        explanation:
          'The server advertises that any origin may read its responses AND that credentials ' +
          'may be sent. Browsers refuse this exact pair, but a server configured this way ' +
          'usually reflects a real origin instead, which does work, and then any website a ' +
          'signed-in user visits can read their data from this API.',
        remediation:
          'Send a specific allow-listed origin with Allow-Credentials, and add `Vary: Origin`. ' +
          'Never pair `*` with credentials.',
      }));
    } else if (acao && acao === PROBE_ORIGIN && credentialsAllowed) {
      findings.push(makeFinding({
        family: FAMILY, owasp: OWASP, severity: SEVERITY.HIGH, vulnerable: true,
        payload: `Origin: ${PROBE_ORIGIN}`,
        signal: `The server echoed our arbitrary origin back: ${evidence}`,
        baseline: 'An allow-list would not contain agentiq-cors-probe.example.',
        explanation:
          'The server reflects whatever Origin it is given and allows credentials, so ANY ' +
          'website can read authenticated responses from this API on behalf of a signed-in user.',
        remediation:
          'Compare the Origin header against a fixed allow-list and echo it only on a match. ' +
          'Add `Vary: Origin` so caches do not serve one origin\'s response to another.',
      }));
    } else if (acao === '*') {
      findings.push(makeFinding({
        family: FAMILY, owasp: OWASP, severity: SEVERITY.LOW, vulnerable: true,
        payload: `Origin: ${PROBE_ORIGIN}`,
        signal: evidence,
        baseline: 'Credentials are NOT allowed, which bounds the impact.',
        explanation:
          'Any origin may read this response. That is appropriate for genuinely public data ' +
          'and a problem otherwise. Credentials are not permitted, so a signed-in user\'s ' +
          'private data is not exposed by this alone.',
        remediation:
          'If this endpoint is not intended to be world-readable, restrict the origin.',
      }));
    }

    return findings.length
      ? { family: FAMILY, owasp: OWASP, checked: 1, findings }
      : {
        ...cleanResult(FAMILY, OWASP, 1),
        note: acao
          ? `Origin ${PROBE_ORIGIN} was not reflected. ${evidence}`
          : 'No CORS headers returned for an untrusted origin: cross-origin reads are refused.',
      };
  },
});
