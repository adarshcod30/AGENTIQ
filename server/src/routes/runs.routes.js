/**
 * /api/runs: start a run, list history, read one run.
 *
 * docs/02_TRD.md §10. Every read is scoped to the caller; see getRun() in
 * services/run.service.js.
 */
import { Router } from 'express';
import { z } from 'zod';
import { startRun, listRuns, getRun } from '../services/run.service.js';
import { resolveUserLlm } from '../services/llm.js';
import { getSpec } from '../services/spec.service.js';
import { getStats } from '../services/stats.service.js';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';
import { RUN_STATE } from '../models/TestRun.js';

const router = Router();

const startSchema = z.object({
  url: z.url({ error: 'A full http(s) URL is required' }),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  description: z.string().min(1, { error: 'Describe what this endpoint is for' }).max(1000),
  count: z.coerce.number().int().min(1).max(12).default(4),
  intendedPublic: z.boolean().default(false),
  specRef: z.string().optional(),
  /** Index into the stored spec's operations: this is what grounds the run. */
  operationIndex: z.coerce.number().int().min(0).optional(),
});

/**
 * POST /api/runs: generate, execute, explain.
 *
 * Always returns 200 with the run: a GEN_FAILED run is a real, persisted
 * result the user can open, not an error to be swallowed. The `state` field
 * carries the verdict.
 */
router.post('/', protectRoute, async (req, res) => {
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  const { url, method, description, count, intendedPublic, specRef, operationIndex } = parsed.data;

  // Spec grounding (docs/01_PRD.md F4). The operation's declared parameters,
  // responses and security schemes go into the prompt, so assertions reference
  // fields the specification actually declares rather than invented ones.
  let operation = null;
  if (specRef) {
    if (!/^[0-9a-f]{24}$/i.test(specRef)) {
      return fail(res, 400, 'INVALID_ID', 'Not a valid spec id');
    }
    const spec = await getSpec({ userId: req.user._id, specId: specRef });
    if (!spec) return fail(res, 404, 'NOT_FOUND', 'Specification not found');
    operation = operationIndex !== undefined
      ? spec.operations[operationIndex] ?? null
      : spec.operations.find((o) => o.method === method) ?? null;
    if (!operation) return fail(res, 404, 'NOT_FOUND', 'Operation not found in that specification');
  }

  // The user's own AI provider (BYOK) drives BOTH generation and the failure
  // explanations; no active provider resolves to the platform-key generateJSON,
  // i.e. the previous behaviour.
  const userLlm = await resolveUserLlm({ userId: req.user._id });

  const run = await startRun({
    userId: req.user._id,
    sessionId,
    target: { url, method, description, intendedPublic },
    count,
    operation,
    specRef: specRef ?? null,
    llm: userLlm,
    explainLlm: userLlm,
  });

  // A run awaiting permission is a 202: the client must show the permission
  // sheet and retry, and no traffic has been sent.
  const status = run.state === RUN_STATE.CANCELLED && run.error?.code === 'AWAITING_GRANT'
    ? 202
    : 200;

  return ok(res, { run: run.toJSON() }, status);
});

const listSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

router.get('/', protectRoute, async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid pagination');
  const { runs, total } = await listRuns({ userId: req.user._id, ...parsed.data });
  return ok(res, { total, count: runs.length, runs });
});

/**
 * GET /api/runs/stats: dashboard aggregates (docs/01_PRD.md F6).
 *
 * Declared BEFORE /:id: Express matches in order, so with the parameter route
 * first, "stats" would be captured as an id and always 400.
 */
router.get('/stats', protectRoute, async (req, res) => {
  const stats = await getStats({ userId: req.user._id });
  return ok(res, stats);
});

router.get('/:id', protectRoute, async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) {
    return fail(res, 400, 'INVALID_ID', 'Not a valid run id');
  }
  // Scoped by userId. A run belonging to someone else is 404, not 403,
  // 403 would confirm the id exists.
  const run = await getRun({ userId: req.user._id, runId: req.params.id });
  if (!run) return fail(res, 404, 'NOT_FOUND', 'Run not found');
  return ok(res, { run });
});

export default router;
