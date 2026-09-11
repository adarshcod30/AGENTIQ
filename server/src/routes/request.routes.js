/**
 * /api/request/send: the API client (docs/01_PRD.md F8).
 *
 * This route contains no HTTP client of its own. Everything goes through the
 * `http_request` MCP tool, so it gets the same treatment as every other
 * outbound request: permission gate, SSRF guard, byte cap, timeout, redirect
 * re-validation and an audit row.
 *
 * That matters more here than anywhere else, because this route's whole job is
 * "fetch whatever URL the user typed". Handing that URL straight to an HTTP
 * library turns the server into an SSRF proxy: a request for
 * http://169.254.169.254/latest/meta-data/iam/security-credentials/ would fetch
 * the cloud metadata endpoint and return the body to the caller.
 *
 * tests/architecture.test.js scans routes and controllers as well as agents, so
 * an HTTP client added here fails the build. The guarantee is structural rather
 * than a matter of remembering.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getTool } from '../mcp/registry.js';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';

const router = Router();

const sendSchema = z.object({
  /**
   * The scheme is checked HERE as well as in the egress guard.
   *
   * z.url() accepts file:, gopher: and friends, and a file: URL has no host,
   * so it reached the permission gate and was refused with "no grant for ''",
   * which is a baffling thing to read when the real answer is "that scheme is
   * never allowed". The guard would have stopped it either way; this makes the
   * refusal say what it means.
   */
  url: z.url({ error: 'A full http(s) URL is required' })
    .refine((u) => {
      // Defensive: a refine must never throw. z.url() should have rejected
      // anything unparseable first, but a validator that can 500 on bad input
      // is a worse bug than the one it was added to fix.
      try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; }
    }, { error: 'Only http and https are allowed' }),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
});

/**
 * protectRoute FIRST. The previous ordering validated the body before checking
 * authentication, so an anonymous caller could probe the validator's error
 * messages. It is a small thing, but auth is the cheapest check and belongs at
 * the front.
 */
router.post('/send', protectRoute, async (req, res) => {
  const parsed = sendSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  const context = { userId: req.user._id, sessionId, runId: null };

  try {
    const result = await getTool('http_request').handler(parsed.data, context);
    return ok(res, result);
  } catch (err) {
    // A host the user has not approved is not an error page: it is the
    // permission sheet, the same as everywhere else in the product.
    if (err.code === 'PERMISSION_DENIED') {
      let host = null;
      try { host = new URL(parsed.data.url).host; } catch { /* validated above */ }
      return fail(res, 403, 'PERMISSION_DENIED', err.message, {
        needsGrant: [{ riskClass: 'network.read', host }],
      });
    }
    // An SSRF refusal is a 400, not a 500: the request was understood and
    // deliberately declined, and the reason is worth showing verbatim.
    if (err.isSsrfBlock) {
      return fail(res, 400, err.code, err.message, { blocked: true });
    }
    return fail(res, 502, err.code ?? 'REQUEST_FAILED', err.message);
  }
});

export default router;
