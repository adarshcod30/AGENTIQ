/**
 * The Railway deployment provider: a stub that proves the seam.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §H, Phase 6 acceptance: "a second provider stub
 * proves the seam." Railway implements the SAME DeploymentProvider interface as
 * Render (preflight, deploy, detectRequirements, diagnoseFailure), so adding it
 * needed no change to the deployment agent or the service. Its deploy() does not
 * yet call the Railway API; it returns a clear, structured "not implemented"
 * result. Filling in the API calls is all that a real Railway provider needs,
 * which is the whole point of the interface.
 */
import { env } from '../config/env.js';
import { detectRequirements } from './requirements.js';
import { diagnoseFailure } from './diagnose.js';

export const railwayProvider = {
  name: 'railway',
  displayName: 'Railway',
  status: 'stub',
  requiresCredential: 'RAILWAY_TOKEN',
  isConfigured: () => Boolean(env.RAILWAY_TOKEN),

  detectRequirements,
  diagnoseFailure,

  async preflight(input) {
    // The same read-only intent as Render's preflight, minus the provider calls.
    return {
      checks: [{
        name: 'provider', status: 'warn',
        detail: 'The Railway provider is a stub: it validates the request but does not deploy yet.',
      }],
      ok: true,
      needsGrant: false,
      parsed: { repo: input.repo, serviceName: input.serviceName },
    };
  },

  async deploy(input) {
    return {
      dryRun: true,
      ok: false,
      notImplemented: true,
      steps: [{ action: 'stub', message: 'Railway provider is not implemented yet.', at: new Date() }],
      serviceId: null,
      deployId: null,
      liveUrl: null,
      deployStatus: null,
      message:
        'The Railway provider is a stub that demonstrates the pluggable interface. '
        + 'Implementing deploy() against the Railway API is all that is needed to make it real.',
      wouldSend: { provider: 'railway', repo: input.repo, serviceName: input.serviceName },
    };
  },
};

export default railwayProvider;
