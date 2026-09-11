/**
 * /api/security: scan only, without generating functional tests.
 *
 * docs/03_App_Flow.md B4. Runs the probe families through the Security Agent,
 * so every payload leaves through an audited, SSRF-guarded MCP tool.
 */
import { Router } from 'express';
import { z } from 'zod';
import { runSecurityAgent, FAMILIES } from '../agents/security.agent.js';
import { getTool } from '../mcp/registry.js';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';

const router = Router();

const FAMILY_KEYS = FAMILIES.map((f) => f.key);

const scanSchema = z.object({
  url: z.url({ error: 'A full http(s) URL is required' }),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /**
   * Load-bearing. When the user declares the endpoint is meant to be public,
   * an anonymous 200 is CORRECT and the auth family reports nothing. Without
   * it, every public API would be reported as having broken authentication.
   */
  intendedPublic: z.boolean().default(false),
  families: z.array(z.enum(FAMILY_KEYS)).default(FAMILY_KEYS),
});

/** GET /api/security/families: what the scanner covers, for the UI. */
router.get('/families', (req, res) =>
  ok(res, { families: FAMILIES.map(({ key, label, owasp }) => ({ key, label, owasp })) }));

router.post('/scan', protectRoute, async (req, res) => {
  const parsed = scanSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  const context = { userId: req.user._id, sessionId, runId: null };

  const scan = await runSecurityAgent({
    ...parsed.data,
    runTool: (name, input, extra = {}) => getTool(name).handler(input, { ...context, ...extra }),
    context,
  });

  // A family refused for want of a grant is reported per family, not as a
  // whole-scan failure: the user may have approved network.read but not
  // network.probe, and the read-only families should still run.
  const needsGrant = scan.families.some((f) => /approve/i.test(f.error ?? ''));

  return ok(res, { ...scan, needsGrant }, 200);
});

export default router;
