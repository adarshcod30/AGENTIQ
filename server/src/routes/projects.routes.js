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
  createProject, updateProjectEnv, importEnvFromFile, discoverProject, listProjects, getProject, DiscoveryError,
} from '../services/discovery.service.js';

const router = Router();

/** Opt-in runtime env for the app under test: a map of KEY -> value, local only. */
const runtimeEnvSchema = z.record(z.string(), z.string()).optional();
/** The npm script that starts the app under test. A name, never a shell command. */
const startScriptSchema = z.string().trim().max(60).optional();
/** A deployed base URL to assess, instead of or alongside a local folder. */
const targetUrlSchema = z.string().trim().url({ error: 'Enter a full http(s) URL' }).optional();
/** A public GitHub repo URL to clone and assess (the service checks the host). */
const repoUrlSchema = z.string().trim().url({ error: 'Enter a full GitHub repo URL' }).optional();

const createSchema = z.object({
  name: z.string().trim().min(1, { error: 'A project name is required' }).max(120),
  workspaceRoot: z.string().trim().min(1).optional(),
  targetUrl: targetUrlSchema,
  repoUrl: repoUrlSchema,
  runtimeEnv: runtimeEnvSchema,
  startScript: startScriptSchema,
}).refine((d) => d.workspaceRoot || d.targetUrl || d.repoUrl, {
  error: 'Provide a project folder path, a deployed URL, or a GitHub repo',
  path: ['workspaceRoot'],
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

/**
 * Update the opt-in runtime config for the app under test: its environment, the
 * start script, and the deployed URL. Owner-scoped. A field left out is left
 * unchanged, so the UI can save the env without clearing the start script.
 */
router.patch('/:id/env', protectRoute, async (req, res) => {
  const parsed = z.object({
    runtimeEnv: runtimeEnvSchema, startScript: startScriptSchema, targetUrl: z.string().trim().optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Provide runtimeEnv as a map of string keys to string values, startScript as a script name, and targetUrl as a URL');
  }
  try {
    const result = await updateProjectEnv({
      userId: req.user._id, projectId: req.params.id,
      runtimeEnv: parsed.data.runtimeEnv, startScript: parsed.data.startScript, targetUrl: parsed.data.targetUrl,
    });
    return ok(res, result);
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * Load the runtime env from the project's own .env file instead of typing it.
 * Owner-scoped, read through the jail, values stored server-side and never
 * returned. The "access" toggle in the UI hits this.
 */
router.post('/:id/env/from-file', protectRoute, async (req, res) => {
  const file = typeof req.body?.file === 'string' && req.body.file.trim() ? req.body.file.trim() : '.env';
  try {
    const result = await importEnvFromFile({ userId: req.user._id, projectId: req.params.id, file });
    return ok(res, result);
  } catch (err) {
    return sendError(res, err);
  }
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
