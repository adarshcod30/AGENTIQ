/**
 * THE MCP REGISTRY: one file owns every tool.
 *
 * docs/02_TRD.md §5.1. This is the core of the design: agents never call an
 * HTTP client, they call a registered tool, and every call is schema-validated,
 * permission-checked, SSRF-guarded and audited.
 *
 * The registry is the single source of truth. /api/mcp/tools serves JSON Schemas
 * GENERATED from these Zod definitions (z.toJSONSchema), never hand-written,
 * because a hand-written schema drifts from the validator within weeks and the
 * Tool Registry page ends up describing tools that no longer exist.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RISK_CLASS, RISK_CLASS_META, grantStore } from './permissions.js';
import { record, hashInput, hostOf, OUTCOME } from './audit.js';
import { EgressError } from './egress.js';
import { logger } from '../lib/logger.js';

export const mcp = new McpServer(
  { name: 'agentiq', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

/** Mirror of everything registered: drives /api/mcp/tools and the permission gate. */
export const TOOLS = [];

/** Reset between test cases. Not used at runtime. */
export function _resetRegistry() {
  TOOLS.length = 0;
}

/**
 * The guard chain. The ORDER IS NOT NEGOTIABLE (docs/02_TRD.md §5.1):
 *
 *   permission → audit(started) → schema validation → egress guard → handler
 *              → audit(ok | denied | error | blocked_ssrf)   [ALWAYS]
 *
 * Permission comes before validation on purpose: a caller who is not allowed to
 * touch a host should be refused without us first parsing their payload, and the
 * denial must be audited even when the payload was garbage.
 *
 * The final audit write happens in a finally block, so a handler that throws
 * still produces a row. An unaudited failure is worse than a failure.
 */
export function withGuards({ name, riskClass, inputSchema, handler }) {
  return async function guarded(rawInput, context = {}) {
    const started = Date.now();
    const { userId = null, sessionId = 'default', runId = null } = context;

    const targetHost = hostOf(rawInput);
    const inputHash = hashInput(rawInput);
    const base = { userId, sessionId, runId, tool: name, riskClass, targetHost, inputHash };

    let outcome = OUTCOME.ERROR;
    let errorCode = null;
    let reason = null;

    try {
      // ── 1. permission ────────────────────────────────────────────────────
      const verdict = grantStore.check({ userId, sessionId, riskClass, host: targetHost });
      if (!verdict.allowed) {
        outcome = OUTCOME.DENIED;
        errorCode = 'PERMISSION_DENIED';
        reason = verdict.reason;
        const err = new Error(verdict.reason);
        err.code = 'PERMISSION_DENIED';
        err.riskClass = riskClass;
        err.targetHost = targetHost;
        throw err;
      }

      // ── 2. schema validation: BEFORE any I/O ─────────────────────────────
      const parsed = inputSchema ? inputSchema.safeParse(rawInput) : { success: true, data: rawInput };
      if (!parsed.success) {
        outcome = OUTCOME.ERROR;
        errorCode = 'VALIDATION_ERROR';
        reason = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        const err = new Error(`Invalid input for ${name}: ${reason}`);
        err.code = 'VALIDATION_ERROR';
        err.details = parsed.error.issues;
        throw err;
      }

      // ── 3. handler (which reaches the network only via the egress guard) ─
      const result = await handler(parsed.data, { ...context, riskClass, tool: name });
      outcome = OUTCOME.OK;
      return result;
    } catch (err) {
      // An SSRF refusal is recorded distinctly: these rows are the clearest
      // evidence that the egress guard works (docs/03_App_Flow.md B6).
      if (err instanceof EgressError) {
        outcome = err.isSsrfBlock
          ? OUTCOME.BLOCKED_SSRF
          : err.code === 'RATE_LIMITED'
            ? OUTCOME.RATE_LIMITED
            : OUTCOME.ERROR;
        errorCode = err.code;
        reason = err.message;
      } else if (!errorCode) {
        errorCode = err.code ?? 'INTERNAL_ERROR';
        reason = err.message;
      }
      throw err;
    } finally {
      // ALWAYS. Even on throw. This is what makes audit-count == call-count true.
      await record({ ...base, outcome, errorCode, reason, durationMs: Date.now() - started });
    }
  };
}

/**
 * Registers a tool with the MCP server and the local mirror.
 *
 * Uses registerTool, NOT the deprecated tool() overload.
 */
export function defineTool({
  name, title, description, riskClass, inputSchema, outputSchema, handler,
}) {
  if (!RISK_CLASS_META[riskClass]) {
    throw new Error(`defineTool(${name}): unknown risk class "${riskClass}"`);
  }
  if (TOOLS.some((t) => t.name === name)) {
    throw new Error(`defineTool(${name}): a tool with that name is already registered`);
  }

  const guarded = withGuards({ name, riskClass, inputSchema, handler });

  TOOLS.push({
    name,
    title,
    description,
    riskClass,
    inputSchema,
    outputSchema,
    handler: guarded,
  });

  attachTool(mcp, TOOLS[TOOLS.length - 1], { sessionId: 'mcp' });

  logger.debug({ tool: name, riskClass }, 'MCP tool registered');
  return guarded;
}

/** The SDK wants a raw shape rather than a ZodObject for its own validation. */
const shapeOf = (schema) => (schema instanceof z.ZodObject ? schema.shape : undefined);

/**
 * Registers one already-guarded tool on an McpServer, bound to an identity.
 *
 * The identity is fixed at REGISTRATION time rather than read per call, because
 * an MCP session belongs to exactly one authenticated caller for its whole
 * life. Binding it here is what lets audit rows name the user who made the
 * call: the previous code passed `userId: extra?.sessionId ? null : null`,
 * which is null on both branches, so every tool call arriving over MCP was
 * audited against nobody.
 */
function attachTool(server, tool, { userId = null, sessionId = 'mcp' } = {}) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: shapeOf(tool.inputSchema) },
    async (args) => {
      const result = await tool.handler(args, { userId, sessionId });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}

/**
 * A FRESH McpServer carrying every registered tool, bound to one caller.
 *
 * Why this exists: `mcp` is a module singleton, and the SDK's connect() binds a
 * server to ONE transport. Connecting the singleton for every HTTP session
 * means a second concurrent session throws and its client gets a 500, so the
 * remote MCP endpoint would serve exactly one client at a time. Two browser
 * tabs, or Claude Desktop alongside the web UI, and one of them breaks.
 *
 * The singleton stays for stdio, where the process genuinely serves one client.
 */
export function createMcpServer({ userId = null, sessionId = 'mcp' } = {}) {
  const server = new McpServer(
    { name: 'agentiq', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  for (const tool of TOOLS) attachTool(server, tool, { userId, sessionId });
  return server;
}

/** Look up a registered tool by name. */
export function getTool(name) {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/**
 * The public registry view: JSON Schemas GENERATED from the Zod definitions.
 *
 * `io: 'input'` matters: a field with a default is not required *of the
 * caller*, and reporting it as required would make the published schema
 * disagree with the validator that actually runs.
 */
export function describeRegistry() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    riskClass: t.riskClass,
    riskClassMeta: RISK_CLASS_META[t.riskClass],
    inputSchema: t.inputSchema ? z.toJSONSchema(t.inputSchema, { io: 'input' }) : null,
    outputSchema: t.outputSchema ? z.toJSONSchema(t.outputSchema, { io: 'output' }) : null,
  }));
}

export { RISK_CLASS };
