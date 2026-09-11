/**
 * /api/projects: register a local project and discover its model.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §F, Phase 1. This route does no I/O of its own
 * (server/tests/architecture.test.js enforces it): the filesystem work happens
 * in discovery.service.js, which drives the jail-bound tools.
 */
import { Router } from 'express';
import { z } from 'zod';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';
import {
  createProject, discoverProject, listProjects, getProject, DiscoveryError,
} from '../services/discovery.service.js';

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(1, { error: 'A project name is required' }).max(120),
  workspaceRoot: z.string().min(1, { error: 'The path to the project folder is required' }),
});

/** Maps a DiscoveryError to its HTTP status; anything else is a real 500. */
function sendError(res, err) {
  if (err instanceof DiscoveryError) {
    return fail(res, err.status, err.code, err.message);
  }
  throw err;
}

router.post('/', protectRoute, async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  try {
    const project = await createProject({ userId: req.user._id, ...parsed.data });
    return ok(res, { project }, 201);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/', protectRoute, async (req, res) => {
  const projects = await listProjects({ userId: req.user._id });
  return ok(res, { projects: projects.map((p) => ({ id: p._id, ...p })) });
});

router.get('/:id', protectRoute, async (req, res) => {
  const result = await getProject({ userId: req.user._id, projectId: req.params.id });
  if (!result) return fail(res, 404, 'NOT_FOUND', 'Project not found');
  return ok(res, result);
});

router.post('/:id/discover', protectRoute, async (req, res) => {
  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  try {
    const discovery = await discoverProject({
      userId: req.user._id, projectId: req.params.id, sessionId,
    });
    return ok(res, { discovery });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
