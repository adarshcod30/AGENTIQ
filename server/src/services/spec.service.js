/**
 * OpenAPI ingestion.
 *
 * docs/01_PRD.md F4. Import by URL or by upload, parse, dereference, extract
 * operations, and persist as an ApiSpec.
 *
 * NOTE THE SEPARATION OF CONCERNS, because it is deliberate and worth being
 * able to explain:
 *
 *   fetching a spec by URL  ->  the `http_request` TOOL (network.read,
 *                               permission-gated, SSRF-guarded, audited)
 *   parsing the document    ->  the `parse_openapi` TOOL (local.compute)
 *
 * A URL supplied by a user is exactly the SSRF vector the egress guard exists
 * for: "import this spec from http://169.254.169.254/latest/meta-data/" is a
 * credential-theft attempt wearing a helpful costume. Routing the fetch through
 * a tool means it cannot bypass the guard, and both halves are separately
 * audited with their own risk classes.
 */
import { ApiSpec } from '../models/ApiSpec.js';
import { logger } from '../lib/logger.js';

/** Specs larger than this go to S3 rather than into a Mongo document. */
export const INLINE_LIMIT_BYTES = 256 * 1024;

/** docs/03_App_Flow.md Part D: accept large specs, but warn about them. */
export const LARGE_SPEC_OPERATIONS = 500;

export class SpecError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Imports a spec that is already in hand as text.
 *
 * @param runTool  the MCP tool runner: parse_openapi goes through it, so the
 *                 parse is audited like every other tool call.
 */
export async function importSpecFromText({
  userId, text, sourceUrl = null, sourceFilename = null, runTool, context = {},
}) {
  const byteSize = Buffer.byteLength(text, 'utf8');

  let parsed;
  try {
    parsed = await runTool('parse_openapi', { spec: text }, context);
  } catch (err) {
    // The tool already produces a located, human-readable message
    // (docs/01_PRD.md F4). Pass it through rather than wrapping it in noise.
    throw new SpecError(
      err.code === 'SPEC_PARSE_ERROR' ? 'SPEC_PARSE_ERROR' : 'SPEC_IMPORT_FAILED',
      err.message,
      err.details,
    );
  }

  if (parsed.operationCount === 0) {
    throw new SpecError(
      'SPEC_NO_OPERATIONS',
      'The document parsed but declares no operations. Check that `paths` is present and populated.',
    );
  }

  const spec = await ApiSpec.create({
    userId,
    title: parsed.title,
    version: parsed.version,
    openapi: parsed.openapi,
    sourceUrl,
    sourceFilename,
    // Kept only when small. Larger documents keep just their extracted
    // operations, so a multi-megabyte spec never sits inside a Mongo document.
    raw: byteSize <= INLINE_LIMIT_BYTES ? text : null,
    byteSize,
    operations: parsed.operations,
    operationCount: parsed.operationCount,
    securitySchemes: parsed.securitySchemes,
  });

  logger.info(
    { specId: String(spec._id), operations: spec.operationCount, byteSize },
    'spec imported',
  );

  return {
    spec,
    warnings: [
      ...(parsed.operationCount > LARGE_SPEC_OPERATIONS
        ? [`This specification declares ${parsed.operationCount} operations. Generating tests for ` +
           'all of them would be slow and expensive: pick the ones you care about.']
        : []),
      ...(byteSize > INLINE_LIMIT_BYTES
        ? [`The document is ${Math.round(byteSize / 1024)} KB, so only its extracted operations were kept.`]
        : []),
    ],
  };
}

/**
 * Imports a spec by URL.
 *
 * The fetch goes through `http_request`, so the egress guard applies: a URL
 * pointing at loopback, a private range or the cloud metadata endpoint is
 * refused before a packet leaves, and the refusal is audited as blocked_ssrf.
 */
export async function importSpecFromUrl({ userId, url, runTool, context = {} }) {
  let response;
  try {
    response = await runTool('http_request', {
      url,
      method: 'GET',
      headers: { accept: 'application/json, application/yaml, text/yaml, text/plain' },
    }, context);
  } catch (err) {
    throw new SpecError(
      err.code === 'BLOCKED_IP' || err.code === 'BLOCKED_HOSTNAME' ? 'SPEC_URL_BLOCKED' : 'SPEC_FETCH_FAILED',
      `Could not fetch the specification: ${err.message}`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw new SpecError(
      'SPEC_FETCH_FAILED',
      `The specification URL returned ${response.status}.`,
      { status: response.status },
    );
  }

  if (response.truncated) {
    throw new SpecError(
      'SPEC_TOO_LARGE',
      'The specification exceeded the response size cap and was truncated, so it cannot be parsed ' +
      'reliably. Upload the file instead.',
    );
  }

  return importSpecFromText({
    userId, text: response.body, sourceUrl: url, runTool, context,
  });
}

/** History, scoped to the owner. */
export async function listSpecs({ userId, limit = 50, skip = 0 }) {
  const [specs, total] = await Promise.all([
    ApiSpec.find({ userId })
      .select('-raw -operations')
      .sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 200))
      .lean(),
    ApiSpec.countDocuments({ userId }),
  ]);
  return { specs, total };
}

/** One spec, scoped by userId: same IDOR discipline as runs. */
export async function getSpec({ userId, specId }) {
  return ApiSpec.findOne({ _id: specId, userId }).lean();
}

/**
 * Turns a spec operation into the auth configuration a run should start with.
 *
 * docs/01_PRD.md F4: "Security schemes in the spec pre-populate the auth
 * configuration." This does NOT invent credentials: it tells the UI which
 * header to ask for, which is the useful half.
 */
export function authConfigFromSpec(spec, operation) {
  const names = operation?.security?.length
    ? operation.security
    : spec.securitySchemes.map((s) => s.name);

  return names
    .map((name) => spec.securitySchemes.find((s) => s.name === name))
    .filter(Boolean)
    .map((scheme) => {
      if (scheme.type === 'http' && /^bearer$/i.test(scheme.scheme ?? '')) {
        return { scheme: scheme.name, header: 'Authorization', prefix: 'Bearer ', valueRequired: true };
      }
      if (scheme.type === 'http' && /^basic$/i.test(scheme.scheme ?? '')) {
        return { scheme: scheme.name, header: 'Authorization', prefix: 'Basic ', valueRequired: true };
      }
      if (scheme.type === 'apiKey') {
        return { scheme: scheme.name, header: scheme.name, prefix: '', valueRequired: true };
      }
      return { scheme: scheme.name, header: null, prefix: '', valueRequired: true };
    });
}

export default { importSpecFromText, importSpecFromUrl, listSpecs, getSpec, authConfigFromSpec };
