/**
 * Deployment orchestration: docs/01_PRD.md F5.
 *
 *      PREFLIGHT ──────────► PREFLIGHT_FAILED   (a read-only check failed;
 *          │                                     nothing was deployed)
 *          │ all checks pass + confirmed grant
 *      DEPLOYING ──────────► DEPLOY_FAILED      (build/start failed, or timed out)
 *          │ live
 *      VERIFYING
 *          │
 *      COMPLETE
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a deployment is not COMPLETE because
 * Render said "live". It is COMPLETE when the testing agent has run against the
 * URL that went live and the result is attached to the record. A deploy button
 * on its own adds nothing; a deployment that verifies itself is the point of F5.
 */
import { Deployment, DEPLOY_STATE } from '../models/Deployment.js';
import { CHECK } from '../agents/deployment.agent.js';
import { getProvider, PROVIDER_NAMES } from '../deploy/index.js';
import { detectRequirements } from '../deploy/requirements.js';
import { runSecurityAgent } from '../agents/security.agent.js';
import { startRun } from './run.service.js';
import { getTool } from '../mcp/registry.js';
import { grantStore, RISK_CLASS } from '../mcp/permissions.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Hosts preflight must be allowed to read before the flow can start. */
export const PREFLIGHT_HOSTS = ['api.github.com'];

/**
 * Families the post-deploy scan may run without asking again.
 *
 * cors and headers are network.read: they read what the server volunteers.
 * sqli, xss and auth are network.probe: they send attack-indicator payloads,
 * and permissions.js is explicit that network.probe is never auto-granted under
 * any configuration. So the automatic verification covers four of six families
 * and SAYS SO, rather than running a partial scan that looks like a full one.
 */
export const AUTO_VERIFY_FAMILIES = ['cors', 'headers'];
export const REQUIRES_APPROVAL_FAMILIES = ['sqli', 'xss', 'auth'];

function defaultRunTool(context) {
  return (name, input, extra = {}) => getTool(name).handler(input, { ...context, ...extra });
}

async function advance(dep, state, note) {
  dep.state = state;
  dep.stateHistory.push({ state, at: new Date(), note });
  await dep.save();
  return dep;
}

async function finish(dep, state, error = null) {
  dep.state = state;
  dep.stateHistory.push({ state, at: new Date(), note: error?.message });
  dep.finishedAt = new Date();
  if (error) dep.error = { code: error.code ?? 'DEPLOY_FAILED', message: error.message };
  await dep.save();
  return dep;
}

/**
 * What the caller still has to approve. Returned to the UI so the permission
 * sheet can ask for everything in one pass rather than failing three times.
 */
export function missingGrants({ userId, sessionId }) {
  const missing = [];

  for (const host of PREFLIGHT_HOSTS) {
    const v = grantStore.check({ userId, sessionId, riskClass: RISK_CLASS.NETWORK_READ, host });
    if (!v.allowed) missing.push({ riskClass: RISK_CLASS.NETWORK_READ, host, reason: v.reason });
  }

  const deploy = grantStore.check({ userId, sessionId, riskClass: RISK_CLASS.DEPLOY_WRITE });
  if (!deploy.allowed) {
    missing.push({ riskClass: RISK_CLASS.DEPLOY_WRITE, host: null, reason: deploy.reason });
  }

  return missing;
}

/**
 * Runs ONLY the read-only phase. Lets a user answer "would this deploy?"
 * without consenting to a deployment.
 */
export async function preflightOnly({ userId, sessionId = 'default', input, runTool, githubApi }) {
  const context = { userId, sessionId };
  const tool = runTool ?? defaultRunTool(context);
  const provider = getProvider(input.provider ?? 'render');
  if (!provider) throw Object.assign(new Error(`Unknown provider: ${input.provider}`), { code: 'UNKNOWN_PROVIDER' });
  return provider.preflight(input, { runTool: tool, context, githubApi });
}

/**
 * The full F5 flow. Always returns a persisted Deployment, in whatever terminal
 * state it reached: a failed deployment is data, not a void.
 */
export async function startDeployment({
  userId,
  sessionId = 'default',
  input,
  runTool,
  sleep,
  pollIntervalMs,
  maxPolls,
  githubApi,
  // Test seam, mirroring run.service.js: lets the post-deploy verification run
  // without a live LLM provider on CI.
  llm,
  verify = true,
}) {
  const providerName = input.provider ?? 'render';
  const provider = getProvider(providerName);
  if (!provider) {
    throw Object.assign(new Error(`Unknown deployment provider: ${providerName}. Choose one of ${PROVIDER_NAMES.join(', ')}.`), { code: 'UNKNOWN_PROVIDER' });
  }

  const dep = await Deployment.create({
    userId,
    provider: providerName,
    repo: input.repo,
    branch: input.branch ?? 'main',
    serviceName: input.serviceName,
    state: DEPLOY_STATE.PREFLIGHT,
    stateHistory: [{ state: DEPLOY_STATE.PREFLIGHT, at: new Date() }],
    startedAt: new Date(),
  });

  const context = { userId, sessionId, deploymentId: String(dep._id) };
  const tool = runTool ?? defaultRunTool(context);

  // ── PHASE 1: preflight ───────────────────────────────────────────────────
  const pre = await provider.preflight(input, {
    runTool: tool, context, ...(githubApi ? { githubApi } : {}),
  });
  dep.preflight = pre.checks;
  await dep.save();

  if (!pre.ok) {
    const failed = pre.checks.filter((c) => c.status === CHECK.FAIL);
    return finish(dep, DEPLOY_STATE.PREFLIGHT_FAILED, Object.assign(
      new Error(
        pre.needsGrant
          ? 'Preflight could not read the repository because permission was not granted for ' +
            `${PREFLIGHT_HOSTS.join(', ')}, so no deployment was attempted.`
          : `${failed.length} preflight check(s) failed, so no deployment was attempted: ` +
            failed.map((c) => `${c.name}: ${c.detail}`).join(' | '),
      ),
      { code: pre.needsGrant ? 'PERMISSION_DENIED' : 'PREFLIGHT_FAILED' },
    ));
  }

  // ── PHASE 2: deploy ──────────────────────────────────────────────────────
  await advance(dep, DEPLOY_STATE.DEPLOYING, 'preflight passed');

  let result;
  try {
    result = await provider.deploy(input, {
      runTool: tool,
      context,
      ...(sleep ? { sleep } : {}),
      ...(pollIntervalMs ? { pollIntervalMs } : {}),
      ...(maxPolls ? { maxPolls } : {}),
    });
  } catch (err) {
    logger.warn({ deploymentId: String(dep._id), err: err.message }, 'deployment failed');
    dep.diagnosis = provider.diagnoseFailure?.(err.message, detectRequirements(null)) ?? null;
    return finish(dep, DEPLOY_STATE.DEPLOY_FAILED, err);
  }

  // A provider stub (or any provider that declines) returns notImplemented.
  if (result.notImplemented) {
    return finish(dep, DEPLOY_STATE.DEPLOY_FAILED, Object.assign(
      new Error(result.message ?? `The ${providerName} provider is not implemented.`),
      { code: 'PROVIDER_NOT_IMPLEMENTED' },
    ));
  }

  dep.serviceId = result.serviceId ?? null;
  dep.deployId = result.deployId ?? null;
  dep.liveUrl = result.liveUrl ?? null;
  await dep.save();

  if (result.dryRun) {
    // A dry run is a successful *plan*, not a deployment. It must not be able to
    // masquerade as one, so it stops here and never reaches VERIFYING.
    return finish(dep, DEPLOY_STATE.PREFLIGHT_FAILED, Object.assign(
      new Error('Dry run: the deployment request was rendered but not sent. Nothing was changed.'),
      { code: 'DRY_RUN' },
    ));
  }

  if (!result.ok) {
    const logs = result.error ?? result.logs ?? `Deploy ended in state "${result.deployStatus}".`;
    dep.diagnosis = provider.diagnoseFailure?.(logs, detectRequirements(null)) ?? null;
    return finish(dep, DEPLOY_STATE.DEPLOY_FAILED, Object.assign(
      new Error(result.error ?? `Deploy ended in state "${result.deployStatus}".`),
      { code: 'DEPLOY_FAILED' },
    ));
  }

  if (!verify || !result.liveUrl) {
    return finish(dep, DEPLOY_STATE.COMPLETE);
  }

  // ── PHASE 3: verify what just went live ──────────────────────────────────
  await advance(dep, DEPLOY_STATE.VERIFYING, `verifying ${result.liveUrl}`);

  try {
    const host = new URL(result.liveUrl).host;

    /**
     * The URL did not exist when the user answered the permission sheet, so
     * there is no grant for it and could not have been. The deploy.write
     * confirmation the user DID give was consent to bring this service into
     * existence, and F5 defines a deployment as including its verification.
     *
     * So: grant network.read for EXACTLY this host, through the normal store so
     * it appears in /api/mcp/grants and in the audit trail like any other grant.
     * network.probe is NOT granted: see AUTO_VERIFY_FAMILIES.
     */
    grantStore.grant({ userId, sessionId, riskClass: RISK_CLASS.NETWORK_READ, host });
    logger.info({ host, deploymentId: String(dep._id) },
      'post-deploy: network.read auto-granted for the host AGENTIQ just deployed');

    const run = await startRun({
      userId,
      sessionId,
      target: {
        url: result.liveUrl,
        method: 'GET',
        description:
          `Post-deployment verification of ${dep.serviceName}, deployed from ` +
          `${dep.repo}@${dep.branch}.`,
      },
      count: 4,
      ...(llm ? { llm } : {}),
    });

    const scan = await runSecurityAgent({
      url: result.liveUrl,
      method: 'GET',
      families: AUTO_VERIFY_FAMILIES,
      runTool: tool,
      context,
    });

    dep.postDeployRunId = run._id;
    dep.verification = {
      testsPassed: run.summary?.passed ?? 0,
      testsTotal: run.summary?.totalTests ?? 0,
      findings: scan.findings.length,
      healthy:
        run.state === 'COMPLETE' &&
        (run.summary?.totalTests ?? 0) > 0 &&
        (run.summary?.failed ?? 0) === 0,
    };
    await dep.save();
  } catch (err) {
    // Verification failing does not un-deploy the service. The deployment is
    // COMPLETE; the verification is recorded as absent, with the reason.
    logger.warn({ deploymentId: String(dep._id), err: err.message }, 'post-deploy verification failed');
    dep.verification = { testsPassed: 0, testsTotal: 0, findings: 0, healthy: false };
    dep.error = { code: 'VERIFY_FAILED', message: err.message };
    await dep.save();
  }

  return finish(dep, DEPLOY_STATE.COMPLETE);
}

/** History for one user. Scoped by userId, never by id alone. */
export async function listDeployments({ userId, limit = 50, skip = 0 }) {
  const [deployments, total] = await Promise.all([
    Deployment.find({ userId }).sort({ startedAt: -1 }).skip(skip).limit(Math.min(limit, 200)).lean(),
    Deployment.countDocuments({ userId }),
  ]);
  return { deployments, total };
}

/** One deployment, scoped to its owner: the same IDOR fix as getRun. */
export async function getDeployment({ userId, deploymentId }) {
  return Deployment.findOne({ _id: deploymentId, userId }).lean();
}

/** True when the deployment agent is usable at all. */
export const isConfigured = () => Boolean(env.RENDER_API_KEY);

export default { startDeployment, preflightOnly, listDeployments, getDeployment, missingGrants };
