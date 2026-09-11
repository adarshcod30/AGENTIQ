/**
 * /api/specs: import and browse OpenAPI specifications.
 *
 * docs/02_TRD.md §10, docs/03_App_Flow.md B3.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  importSpecFromText, importSpecFromUrl, listSpecs, getSpec, authConfigFromSpec, SpecError,
} from '../services/spec.service.js';
import { getTool } from '../mcp/registry.js';
import { protectRoute } from '../middleware/auth.js';
import { ok, fail } from '../utils/http.js';

const router = Router();

/** Binds the MCP registry to this request, so tool calls carry run context. */
function toolRunner(req) {
  const sessionId = req.get('x-session-id') ?? String(req.user._id);
  const context = { userId: req.user._id, sessionId };
  return (name, input, extra = {}) => getTool(name).handler(input, { ...context, ...extra });
}

const importSchema = z.union([
  z.object({ url: z.url({ error: 'Provide a full http(s) URL' }) }),
  z.object({
    spec: z.string().min(1, { error: 'Paste or upload the specification' }),
    filename: z.string().max(200).optional(),
  }),
]);

/**
 * POST /api/specs/import: by URL or by pasted/uploaded text.
 *
 * A URL is fetched through the http_request TOOL, so the egress guard applies:
 * importing "http://169.254.169.254/latest/meta-data/" is refused before a
 * packet leaves and audited as blocked_ssrf.
 */
router.post('/import', protectRoute, async (req, res) => {
  const parsed = importSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR',
      'Provide either a URL or the specification text',
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }

  const runTool = toolRunner(req);
  const context = { userId: req.user._id, sessionId: req.get('x-session-id') ?? String(req.user._id) };

  try {
    const result = 'url' in parsed.data
      ? await importSpecFromUrl({ userId: req.user._id, url: parsed.data.url, runTool, context })
      : await importSpecFromText({
        userId: req.user._id, text: parsed.data.spec,
        sourceFilename: parsed.data.filename ?? null, runTool, context,
      });

    return ok(res, {
      spec: {
        id: result.spec._id,
        title: result.spec.title,
        version: result.spec.version,
        openapi: result.spec.openapi,
        operationCount: result.spec.operationCount,
        operations: result.spec.operations,
        securitySchemes: result.spec.securitySchemes,
        sourceUrl: result.spec.sourceUrl,
      },
      warnings: result.warnings,
    }, 201);
  } catch (err) {
    if (err instanceof SpecError) {
      // A parse failure is the user's file being wrong, not a server error.
      const status = err.code === 'SPEC_URL_BLOCKED' ? 403
        : err.code === 'SPEC_FETCH_FAILED' ? 502
          : 400;
      return fail(res, status, err.code, err.message, err.details);
    }
    throw err;
  }
});

const listQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

router.get('/', protectRoute, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return fail(res, 400, 'VALIDATION_ERROR', 'Invalid pagination');
  const { specs, total } = await listSpecs({ userId: req.user._id, ...parsed.data });
  return ok(res, { total, count: specs.length, specs });
});

router.get('/:id', protectRoute, async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) {
    return fail(res, 400, 'INVALID_ID', 'Not a valid spec id');
  }
  // Scoped by userId. Someone else's spec is 404, not 403.
  const spec = await getSpec({ userId: req.user._id, specId: req.params.id });
  if (!spec) return fail(res, 404, 'NOT_FOUND', 'Specification not found');
  return ok(res, { spec });
});

/**
 * GET /api/specs/:id/operations/:index/auth: what credentials this operation
 * declares it needs, so the run form can ask for the right header.
 */
router.get('/:id/operations/:index/auth', protectRoute, async (req, res) => {
  if (!/^[0-9a-f]{24}$/i.test(req.params.id)) {
    return fail(res, 400, 'INVALID_ID', 'Not a valid spec id');
  }
  const spec = await getSpec({ userId: req.user._id, specId: req.params.id });
  if (!spec) return fail(res, 404, 'NOT_FOUND', 'Specification not found');

  const operation = spec.operations[Number(req.params.index)];
  if (!operation) return fail(res, 404, 'NOT_FOUND', 'Operation not found');

  return ok(res, { operation: { method: operation.method, path: operation.path },
    auth: authConfigFromSpec(spec, operation) });
});

export default router;
