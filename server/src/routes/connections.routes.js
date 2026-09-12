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
import { oauthStartUrl, handleOAuthCallback, oauthProviders, OAuthError } from '../services/oauth.service.js';
import { env } from '../config/env.js';

const router = Router();

function sendError(res, err) {
  if (err instanceof ConnectionError || err instanceof OAuthError) {
    return fail(res, err.status, err.code, err.message);
  }
  throw err;
}

router.get('/', protectRoute, async (req, res) => {
  const connections = await listConnections({ userId: req.user._id });
  return ok(res, { connections, oauth: oauthProviders() });
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

/** Begin an OAuth connect: returns the provider authorize URL for the SPA to open. */
router.post('/:provider/oauth/start', protectRoute, async (req, res) => {
  try {
    const url = oauthStartUrl({ provider: req.params.provider, userId: req.user._id });
    return ok(res, { url });
  } catch (err) {
    return sendError(res, err);
  }
});

/**
 * OAuth callback. PUBLIC: the provider redirects the browser here with no app
 * auth, so identity comes from the signed state, not protectRoute. Verifies the
 * state, exchanges the code, stores the connection, then bounces to Settings with
 * a result flag.
 */
router.get('/:provider/oauth/callback', async (req, res) => {
  const settings = `${env.APP_BASE_URL.replace(/\/+$/, '')}/settings`;
  try {
    const { provider } = await handleOAuthCallback({
      provider: req.params.provider, code: req.query.code, state: req.query.state,
    });
    return res.redirect(`${settings}?connected=${encodeURIComponent(provider)}`);
  } catch (err) {
    const message = err instanceof OAuthError ? err.message : 'Could not connect the account.';
    return res.redirect(`${settings}?connect_error=${encodeURIComponent(message)}`);
  }
});

export default router;
