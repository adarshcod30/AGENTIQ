/**
 * The Vercel deployment provider.
 *
 * Vercel deploys are multi-tenant: they use the CURRENT user's connected Vercel
 * token (Settings -> Connections), never a shared key, which is why the platform
 * env fallback isConfigured() is always false here; the deploy route's per-user
 * gate lets a user through on their own connection. The connection is wired and
 * stored; the deploy() call against Vercel's API is a documented preview,
 * structured exactly like Render so filling it in needs no change to the agent
 * or the service.
 */
import { detectRequirements } from './requirements.js';
import { diagnoseFailure } from './diagnose.js';

export const vercelProvider = {
  name: 'vercel',
  displayName: 'Vercel',
  status: 'stub',
  requiresCredential: 'Vercel connection',
  // No platform env fallback: a user connects their own token in Settings.
  isConfigured: () => false,

  detectRequirements,
  diagnoseFailure,

  async preflight(input) {
    return {
      checks: [{
        name: 'provider',
        status: 'warn',
        detail: 'The Vercel provider is in preview: it validates the request, and your Vercel '
          + 'connection is saved and ready, but the deploy call is not wired yet.',
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
      steps: [{ action: 'stub', message: 'Vercel provider is in preview.', at: new Date() }],
      serviceId: null,
      deployId: null,
      liveUrl: null,
      deployStatus: null,
      message:
        'The Vercel provider is in preview. Your Vercel token is connected and stored; wiring '
        + 'deploy() to the Vercel API is the next step, structured exactly like the Render provider.',
      wouldSend: { provider: 'vercel', repo: input.repo, serviceName: input.serviceName },
    };
  },
};

export default vercelProvider;
