/**
 * /api/providers: a user's own AI-provider credentials (BYOK).
 *
 * GET returns the field spec plus presence/config for every provider (never a
 * secret). PUT stores and verifies one. POST .../activate selects the provider a
 * user's generation uses; POST /deactivate falls back to platform keys. DELETE
 * removes one. Owner-scoped throughout; a secret only ever travels inbound.
 */
import { Router } from 'express';
import { z } from 'zod';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';
import {
  setProviderCredential, listProviderCredentials, providerSpecs,
  setActiveProvider, clearActiveProvider, removeProviderCredential, ProviderError,
} from '../services/providers.service.js';

const router = Router();

function sendError(res, err) {
  if (err instanceof ProviderError) return fail(res, err.status, err.code, err.message);
  throw err;
}

router.get('/', protectRoute, async (req, res) => {
  const providers = await listProviderCredentials({ userId: req.user._id });
  return ok(res, { specs: providerSpecs(), providers });
});

const fieldsSchema = z.object({ fields: z.record(z.string(), z.string()) });

router.put('/:provider', protectRoute, async (req, res) => {
  const parsed = fieldsSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Send fields as an object of string values.');
  try {
    const result = await setProviderCredential({ userId: req.user._id, provider: req.params.provider, fields: parsed.data.fields });
    return ok(res, result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/:provider/activate', protectRoute, async (req, res) => {
  try {
    return ok(res, await setActiveProvider({ userId: req.user._id, provider: req.params.provider }));
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/deactivate', protectRoute, async (req, res) => {
  return ok(res, await clearActiveProvider({ userId: req.user._id }));
});

router.delete('/:provider', protectRoute, async (req, res) => {
  try {
    return ok(res, await removeProviderCredential({ userId: req.user._id, provider: req.params.provider }));
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
