/**
 * /api/deployments: docs/01_PRD.md F5, docs/03_App_Flow.md B5.
 *
 * Note the route ORDER: /preflight and /config are declared before /:id, or
 * Express reads "preflight" as a deployment id: the same trap that had to be
 * fixed for /api/runs/stats.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  startDeployment, preflightOnly, listDeployments, getDeployment,
  missingGrants, isConfigured,
  AUTO_VERIFY_FAMILIES, REQUIRES_APPROVAL_FAMILIES, PREFLIGHT_HOSTS,
} from '../services/deployment.service.js';
import { listProviders, PROVIDER_NAMES } from '../deploy/index.js';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';

const router = Router();

const deploySchema = z.object({
  provider: z.enum(PROVIDER_NAMES).default('render'),
  repo: z.url({ error: 'A full https://github.com/owner/repo URL is required' }),
  branch: z.string().min(1).default('main'),
  serviceName: z.string().min(1).max(90),
  runtime: z.enum(['node', 'python', 'ruby', 'go', 'docker']).default('node'),
  plan: z.enum(['free', 'starter', 'standard']).default('free'),
  region: z.enum(['oregon', 'frankfurt', 'singapore', 'ohio', 'virginia']).default('oregon'),
  buildCommand: z.string().max(400).default('npm install'),
  startCommand: z.string().max(400).default('npm start'),
  envVars: z.record(z.string(), z.string()).default({}),
  dryRun: z.boolean().default(false),
});

const sessionOf = (req) => req.get('x-session-id') ?? String(req.user._id);

/** What the agent can and cannot do, so the UI never has to guess. */
router.get('/config', protectRoute, (req, res) => ok(res, {
  configured: isConfigured(),
  provider: 'render',
  providers: listProviders(),
  preflightHosts: PREFLIGHT_HOSTS,
  autoVerifyFamilies: AUTO_VERIFY_FAMILIES,
  requiresApprovalFamilies: REQUIRES_APPROVAL_FAMILIES,
  note: isConfigured()
    ? 'Deployments target Render. AGENTIQ itself runs on AWS: see docs/05_AWS_ARCHITECTURE.md.'
    : 'RENDER_API_KEY is not configured, so no deployment can be attempted.',
}));

/** Read-only. Answers "would this deploy?" without consenting to a deployment. */
router.post('/preflight', protectRoute, async (req, res) => {
  const parsed = deploySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  try {
    const result = await preflightOnly({
      userId: req.user._id, sessionId: sessionOf(req), input: parsed.data,
    });
    return ok(res, result);
  } catch (err) {
    if (err.code === 'PERMISSION_DENIED') {
      return fail(res, 403, 'PERMISSION_DENIED', err.message, {
        needsGrant: [{ riskClass: 'network.read', host: PREFLIGHT_HOSTS[0] }],
      });
    }
    throw err;
  }
});

router.post('/', protectRoute, async (req, res) => {
  const parsed = deploySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  if (!isConfigured()) {
    return fail(res, 503, 'DEPLOY_NOT_CONFIGURED',
      'RENDER_API_KEY is not configured, so no deployment can be attempted.');
  }

  const sessionId = sessionOf(req);

  // Ask for EVERYTHING up front. Failing three times in a row, once per missing
  // grant, is a worse experience than one sheet listing all of it.
  const missing = missingGrants({ userId: req.user._id, sessionId });
  if (missing.length) {
    return fail(res, 403, 'PERMISSION_DENIED',
      'This deployment needs permissions that have not been granted for this session.',
      { needsGrant: missing });
  }

  const deployment = await startDeployment({
    userId: req.user._id, sessionId, input: parsed.data,
  });

  return ok(res, { deployment }, 201);
});

router.get('/', protectRoute, async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const result = await listDeployments({ userId: req.user._id, limit });
  return ok(res, { ...result, count: result.deployments.length });
});

router.get('/:id', protectRoute, async (req, res) => {
  const deployment = await getDeployment({ userId: req.user._id, deploymentId: req.params.id });
  if (!deployment) return fail(res, 404, 'NOT_FOUND', 'No such deployment.');
  return ok(res, { deployment });
});

router.get('/providers', protectRoute, (req, res) => ok(res, { providers: listProviders() }));

export default router;
