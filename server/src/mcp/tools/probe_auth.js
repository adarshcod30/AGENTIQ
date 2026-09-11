/**
 * probe_auth: broken authentication.
 *
 * The naive rule is:
 *
 *     any 200 without credentials  ->  "Accessible without authentication"
 *
 * That flags every public API on the internet, which makes any claim of "no
 * false positives on well-built endpoints" impossible to sustain.
 *
 * TWO MECHANISMS PREVENT IT (docs/01_PRD.md F3):
 *
 *   1. `intendedPublic`: when the user declares the endpoint is meant to be
 *      reachable anonymously, an anonymous 200 is CORRECT BEHAVIOUR and this
 *      probe says so instead of reporting a vulnerability.
 *
 *   2. Differential: a finding requires that stripping credentials leaves the
 *      response MATERIALLY UNCHANGED. If the caller supplied no credentials in
 *      the first place there is nothing to strip, and therefore nothing to
 *      conclude: a bare 200 proves only that the endpoint answered.
 */
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { probeInputSchema, probeOutputSchema } from './_probeSchema.js';
import {
  captureBaseline, compare, describeBaseline,
  makeFinding, cleanResult, SEVERITY,
} from '../probes/baseline.js';

export const inputSchema = probeInputSchema;
export const outputSchema = probeOutputSchema;

const FAMILY = 'auth';
const OWASP = 'API2:2023 Broken Authentication';

/** Header names that carry credentials, and are therefore what we strip. */
export const CREDENTIAL_HEADERS = [
  'authorization', 'cookie', 'x-api-key', 'x-auth-token', 'api-key', 'x-access-token',
];

export function stripCredentials(headers = {}) {
  const stripped = {};
  const removed = [];
  for (const [key, value] of Object.entries(headers)) {
    if (CREDENTIAL_HEADERS.includes(key.toLowerCase())) { removed.push(key); continue; }
    stripped[key] = value;
  }
  return { headers: stripped, removed };
}

export default defineTool({
  name: 'probe_auth',
  title: 'Broken authentication probe',
  description:
    'Re-request with credentials stripped and compare against the authenticated baseline. ' +
    'Reports nothing when the endpoint is declared intentionally public.',
  riskClass: RISK_CLASS.NETWORK_PROBE,
  inputSchema,
  outputSchema,

  async handler(input) {
    const { url, method, headers, intendedPublic } = input;

    // ── MECHANISM 1: the user's declaration ───────────────────────────────
    // Checked FIRST, before any request. A public endpoint answering
    // anonymously is correct, and there is nothing here worth measuring.
    if (intendedPublic) {
      return {
        family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        note:
          'Endpoint declared intentionally public. An anonymous 200 is correct behaviour ' +
          'here, so no authentication finding is possible.',
      };
    }

    const { headers: anonymous, removed } = stripCredentials(headers);

    // ── MECHANISM 2: there must be something to strip ─────────────────────
    if (removed.length === 0) {
      return {
        family: FAMILY, owasp: OWASP, checked: 0, findings: [],
        note:
          'No credentials were supplied, so none could be stripped. A 200 here shows only ' +
          'that the endpoint answered: it is not evidence that authentication is missing. ' +
          'Supply the credentials this endpoint expects, or mark it as intentionally public.',
      };
    }

    // ── THREE requests, because two cannot tell the cases apart ───────────
    //
    //   authed    the credentials the caller supplied
    //   tampered  a deliberately INVALID credential
    //   anon      no credentials at all
    //
    // The tampered request is the discriminator, and it is what a two-request
    // probe gets wrong. If an endpoint returns the same thing for a VALID and
    // an INVALID credential, it is not checking credentials at all: it is a
    // public endpoint, and removing the header proves nothing. Reporting that
    // as broken authentication is the naive rule's false positive, just
    // reached by a different route.
    const tamperedHeaders = { ...anonymous };
    const credentialHeader = removed.find((h) => h.toLowerCase() === 'authorization') ?? removed[0];
    tamperedHeaders[credentialHeader] = 'Bearer agentiq-invalid-credential-probe';

    let authed;
    let tampered;
    let anon;
    try {
      authed = await fetchGuarded(url, { method, headers });
      tampered = await fetchGuarded(url, { method, headers: tamperedHeaders });
      anon = await fetchGuarded(url, { method, headers: anonymous });
    } catch (err) {
      return { family: FAMILY, owasp: OWASP, checked: 1, findings: [],
        error: `Request failed: ${err.message}` };
    }

    const baseline = captureBaseline(authed);
    const anonDiff = compare(baseline, anon);
    const tamperDiff = compare(baseline, tampered);

    if (authed.status >= 400) {
      return {
        family: FAMILY, owasp: OWASP, checked: 3, findings: [],
        note: `The authenticated request returned ${authed.status}; the supplied credentials ` +
              'may be wrong. No comparison is possible.',
      };
    }

    const credentialsAreChecked = tampered.status >= 400
      || tamperDiff.statusChanged
      || tamperDiff.lengthChangedMaterially;

    // CASE A: the endpoint ignores credentials entirely: a forged token is
    // answered exactly like a real one.
    //
    // From the outside, "public endpoint working correctly" and "privileged
    // route with no auth check" look IDENTICAL. Both serve everyone. Nothing
    // observable separates them, which is exactly why docs/01_PRD.md F3 makes
    // intent a user declaration rather than a guess.
    //
    // intendedPublic=true was handled at the top of this handler and returned
    // clean. Reaching here means the user declared the route SHOULD be
    // protected, and it is not.
    if (!credentialsAreChecked) {
      return {
        family: FAMILY, owasp: OWASP, checked: 3,
        findings: [makeFinding({
          family: FAMILY, owasp: OWASP, severity: SEVERITY.HIGH, vulnerable: true,
          payload: `Forged credential: "${credentialHeader}: Bearer agentiq-invalid-credential-probe"`,
          signal:
            `A deliberately INVALID credential returned ${tampered.status}: the same as a valid ` +
            `one (${authed.status}) and the same as none at all (${anon.status}). The route does ` +
            'not check credentials.',
          baseline: `${describeBaseline(baseline)}. valid → ${authed.status}, ` +
                    `forged → ${tampered.status}, anonymous → ${anon.status}`,
          explanation:
            'No credential check runs on this route: a forged token is accepted exactly like a ' +
            'real one. You did not mark this endpoint as intentionally public, so anyone can ' +
            'reach whatever it serves.',
          remediation:
            'Add authentication middleware ahead of the handler. If this endpoint really is ' +
            'meant to be public, mark it as such so it is not reported again.',
        })],
      };
    }

    // CASE B: credentials ARE validated (a forged one is rejected), yet an
    // anonymous request still succeeds. That is a genuine bypass.
    const anonSucceeds = anon.status >= 200 && anon.status < 300;
    if (anonSucceeds && !anonDiff.statusChanged && !anonDiff.lengthChangedMaterially) {
      return {
        family: FAMILY, owasp: OWASP, checked: 3,
        findings: [makeFinding({
          family: FAMILY, owasp: OWASP, severity: SEVERITY.CRITICAL, vulnerable: true,
          payload: `Removed request headers: ${removed.join(', ')}`,
          signal:
            `A forged credential was REJECTED with ${tampered.status}, so this route does ` +
            `validate credentials, yet removing them entirely still returned ${anon.status} ` +
            `(${anonDiff.probe.length} bytes vs ${baseline.length} authenticated).`,
          baseline: `${describeBaseline(baseline)}. ${anonDiff.summary}`,
          explanation:
            'The route checks a credential when one is present but does not require one to be ' +
            'present, so an unauthenticated caller reaches the same protected data.',
          remediation:
            'Reject missing credentials in the same middleware that rejects invalid ones, and ' +
            'authorise the specific resource, not merely that some valid token exists.',
        })],
      };
    }

    return {
      ...cleanResult(FAMILY, OWASP, 3),
      note: anonSucceeds
        ? `Anonymous request returned ${anon.status} but the response differs materially ` +
          `(${anonDiff.summary}), consistent with a reduced public view.`
        : `A forged credential was rejected with ${tampered.status} and an anonymous request ` +
          `with ${anon.status}. Authentication is enforced.`,
    };
  },
});
