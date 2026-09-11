/**
 * /api/assessments: run and follow an autonomous assessment.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §F, Phase 4. POST enqueues a job and returns at
 * once; the client polls GET /:id to watch the phase timeline. No I/O here (the
 * architecture guard covers routes): the orchestration is in the service.
 */
import { Router } from 'express';
import { z } from 'zod';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';
import {
  createAssessment, listAssessments, getAssessment, answerClarification, AssessmentError,
} from '../services/assessment.service.js';

const router = Router();

const createSchema = z.object({
  projectId: z.string().min(1, { error: 'A projectId is required' }),
  pauseOnClarification: z.boolean().default(false),
});

const answerSchema = z.object({
  endpoint: z.string().min(1),
  answer: z.string().min(1).max(2000),
});

function sendError(res, err) {
  if (err instanceof AssessmentError) return fail(res, err.status, err.code, err.message);
  throw err;
}

router.post('/', protectRoute, async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  try {
    const assessment = await createAssessment({ userId: req.user._id, ...parsed.data });
    return ok(res, { assessment }, 201);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/', protectRoute, async (req, res) => {
  const assessments = await listAssessments({ userId: req.user._id, projectId: req.query.projectId ?? null });
  return ok(res, { assessments });
});

router.get('/:id', protectRoute, async (req, res) => {
  const assessment = await getAssessment({ userId: req.user._id, assessmentId: req.params.id });
  if (!assessment) return fail(res, 404, 'NOT_FOUND', 'Assessment not found');
  return ok(res, { assessment });
});

router.post('/:id/answer', protectRoute, async (req, res) => {
  const parsed = answerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Provide the endpoint and an answer');
  }
  try {
    const assessment = await answerClarification({
      userId: req.user._id, assessmentId: req.params.id, ...parsed.data,
    });
    return ok(res, { assessment });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
