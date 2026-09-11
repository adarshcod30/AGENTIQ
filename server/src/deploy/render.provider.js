/**
 * The Render deployment provider.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D, Phase 6. Render is the first implementation
 * of the DeploymentProvider interface. It wraps the existing, tested Render
 * orchestration (runPreflight/runDeploy in the deployment agent, which drive the
 * deploy_service MCP tool), so nothing about how Render deploys changes: the
 * provider layer only makes WHICH provider a choice.
 */
import { env } from '../config/env.js';
import { runPreflight, runDeploy } from '../agents/deployment.agent.js';
import { detectRequirements } from './requirements.js';
import { diagnoseFailure } from './diagnose.js';

export const renderProvider = {
  name: 'render',
  displayName: 'Render',
  status: 'available',
  requiresCredential: 'RENDER_API_KEY',
  isConfigured: () => Boolean(env.RENDER_API_KEY),

  detectRequirements,
  diagnoseFailure,

  /** Read-only checks against GitHub before any deploy.write action. */
  async preflight(input, { runTool, context, githubApi }) {
    return runPreflight({ ...input, runTool, context, ...(githubApi ? { githubApi } : {}) });
  },

  /** The deploy itself: find owner, create or find service, trigger, poll. */
  async deploy(input, { runTool, context, sleep, pollIntervalMs, maxPolls }) {
    return runDeploy({
      ...input,
      runTool,
      context,
      ...(sleep ? { sleep } : {}),
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
      ...(maxPolls ? { maxPolls } : {}),
    });
  },
};

export default renderProvider;
