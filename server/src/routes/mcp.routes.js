/**
 * /api/mcp/*: the routes that let a human check the architecture claim.
 *
 * docs/01_PRD.md F1 requires a Tool Registry page (every tool, its schema and
 * its risk class) and an Audit Log page (real invocations). Those two pages are
 * how the claim gets checked.
 *
 * If a claim about the architecture cannot be demonstrated in one click from
 * the running app, either build the click or drop the claim.
 */
import { Router } from 'express';
import { z } from 'zod';
import { describeRegistry, TOOLS } from '../mcp/registry.js';
import { query as queryAudit } from '../mcp/audit.js';
import { grantStore, RISK_CLASSES, RISK_CLASS_META } from '../mcp/permissions.js';
import { protectRoute } from '../middleware/auth.js';
import { handleMcpRequest } from '../mcp/transport.js';
import { ok, fail } from '../utils/http.js';
import { OUTCOMES } from '../models/AuditEvent.js';

const router = Router();

/**
 * GET /api/mcp/tools: the live registry.
 *
 * Schemas are GENERATED from the Zod definitions on every request, so this
 * endpoint cannot drift from the validator that actually runs. That is the
 * whole reason the Tool Registry page can honestly say "nothing on this page
 * is hardcoded".
 */
router.get('/tools', (req, res) => {
  const tools = describeRegistry();
  return ok(res, {
    count: tools.length,
    generatedFrom: 'zod',
    note: 'Generated from the running server MCP registry. Nothing here is hardcoded.',
    riskClasses: RISK_CLASSES.map((c) => ({ name: c, ...RISK_CLASS_META[c] })),
    tools,
  });
});

/** GET /api/mcp/audit: read-only, filterable. No update or delete counterpart. */
const auditQuerySchema = z.object({
  runId: z.string().optional(),
  tool: z.string().optional(),
  outcome: z.enum(OUTCOMES).optional(),
  riskClass: z.enum(RISK_CLASSES).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

router.get('/audit', protectRoute, async (req, res) => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid filter', parsed.error.issues);
  }
  // Scoped to the signed-in user: one user owns their runs (docs/01_PRD.md §4).
  const { events, total } = await queryAudit({ ...parsed.data, userId: req.user._id });
  return ok(res, { total, count: events.length, events });
});

/**
 * POST /api/mcp/grants: approve a risk class for a host, for this session.
 *
 * This is the server side of the permission sheet. network.probe is never
 * auto-granted; it can only arrive here, from a deliberate human action.
 */
const grantSchema = z.object({
  riskClass: z.enum(RISK_CLASSES),
  host: z.string().min(1).optional(),
  confirmed: z.boolean().default(false),
});

router.post('/grants', protectRoute, (req, res) => {
  const parsed = grantSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Invalid grant', parsed.error.issues);
  }
  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  try {
    const grant = grantStore.grant({
      userId: String(req.user._id),
      sessionId,
      ...parsed.data,
    });
    return ok(res, { grant, sessionId }, 201);
  } catch (err) {
    return fail(res, 400, err.code ?? 'BAD_REQUEST', err.message);
  }
});

/** GET /api/mcp/grants: what this session currently allows. */
router.get('/grants', protectRoute, (req, res) => {
  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  return ok(res, {
    sessionId,
    grants: grantStore.list({ userId: String(req.user._id), sessionId }),
  });
});

/** DELETE /api/mcp/grants: revoke. Grants are revocable; audit rows are not. */
router.delete('/grants', protectRoute, (req, res) => {
  const parsed = grantSchema.partial().safeParse(req.body ?? {});
  if (!parsed.success || !parsed.data.riskClass) {
    return fail(res, 400, 'VALIDATION_ERROR', 'riskClass is required');
  }
  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  const removed = grantStore.revoke({
    userId: String(req.user._id),
    sessionId,
    riskClass: parsed.data.riskClass,
    host: parsed.data.host ?? null,
  });
  return ok(res, { revoked: removed });
});

/**
 * ALL /api/mcp: the streamable-HTTP MCP transport (docs/02_TRD.md §5.4).
 *
 * Declared LAST so the concrete routes above (/tools, /audit, /grants, /status)
 * win; Express matches in order, and a router-level catch-all placed first
 * would swallow them.
 *
 * Behind auth. Every tool call arriving here still passes through the same
 * withGuards() chain as an internal call, because the guards live in the
 * registry rather than in this handler.
 */
router.all('/', protectRoute, handleMcpRequest);

/** Convenience for the About page: how many tools are registered right now. */
router.get('/status', (req, res) =>
  ok(res, {
    toolCount: TOOLS.length,
    tools: TOOLS.map((t) => ({ name: t.name, riskClass: t.riskClass })),
  }),
);

export default router;
