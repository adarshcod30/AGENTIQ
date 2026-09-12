/**
 * /api/connections: a user's own GitHub / Render / Vercel tokens.
 *
 * GET returns presence only (never a token). PUT stores a token (encrypted at
 * rest by the service). DELETE removes one. Every route is owner-scoped through
 * protectRoute, and a token only ever travels INbound.
 */
import { Router } from 'express';
import { z } from 'zod';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';
import {
  setConnection, listConnections, removeConnection, ConnectionError,
} from '../services/connections.service.js';

const router = Router();

function sendError(res, err) {
  if (err instanceof ConnectionError) return fail(res, err.status, err.code, err.message);
  throw err;
}

router.get('/', protectRoute, async (req, res) => {
  const connections = await listConnections({ userId: req.user._id });
  return ok(res, { connections });
});

const tokenSchema = z.object({ token: z.string().min(1, { error: 'A token is required' }) });

router.put('/:provider', protectRoute, async (req, res) => {
  const parsed = tokenSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'A token is required');
  try {
    const result = await setConnection({ userId: req.user._id, provider: req.params.provider, token: parsed.data.token });
    return ok(res, result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/:provider', protectRoute, async (req, res) => {
  try {
    const result = await removeConnection({ userId: req.user._id, provider: req.params.provider });
    return ok(res, result);
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
