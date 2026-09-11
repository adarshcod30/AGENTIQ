/**
 * The deployment provider registry.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D, Phase 6. One place lists every provider, so
 * the deployment service dispatches by name and the UI can offer the choice.
 * Adding a provider is adding one implementation file and one line here; the
 * agent and the service do not change.
 *
 * The DeploymentProvider interface every entry implements:
 *   name, displayName, status ('available' | 'stub'), requiresCredential
 *   isConfigured() -> boolean
 *   detectRequirements(pkg, opts) -> requirements
 *   diagnoseFailure(logs, requirements) -> diagnosis
 *   preflight(input, deps) -> { checks, ok, needsGrant, parsed }
 *   deploy(input, deps) -> { ok, dryRun, serviceId, deployId, liveUrl, deployStatus, steps, message }
 */
import { renderProvider } from './render.provider.js';
import { railwayProvider } from './railway.provider.js';

export const PROVIDERS = {
  [renderProvider.name]: renderProvider,
  [railwayProvider.name]: railwayProvider,
};

/** Provider names a deploy request may name. */
export const PROVIDER_NAMES = Object.keys(PROVIDERS);

export function getProvider(name) {
  return PROVIDERS[name] ?? null;
}

/** Public metadata for the UI and /api/deployments/config. Never a credential. */
export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    name: p.name,
    displayName: p.displayName,
    status: p.status,
    requiresCredential: p.requiresCredential,
    configured: p.isConfigured(),
  }));
}
