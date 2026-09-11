/**
 * Streamable-HTTP MCP transport, mounted at /api/mcp behind auth.
 *
 * docs/02_TRD.md §5.4. Lets a remote MCP client drive AGENTIQ's tools over
 * HTTP rather than a local subprocess.
 *
 * SECURITY NOTE: this endpoint is authenticated, and every tool call arriving
 * through it still goes through the same withGuards() chain as an internal
 * call: permission check, schema validation, egress guard, audit. Exposing the tool layer over
 * HTTP does not create a side channel around the controls, because the controls
 * live in the registry rather than in the route handler.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { createMcpServer } from './registry.js';
import { logger } from '../lib/logger.js';

/**
 * One transport per MCP session, keyed by the session id the SDK issues.
 * Kept in memory: a session is a live connection, not durable state.
 */
const sessions = new Map();

export function sessionCount() {
  return sessions.size;
}

export async function closeAllSessions() {
  await Promise.all([...sessions.values()].map((t) => t.close().catch(() => {})));
  sessions.clear();
}

/**
 * Express handler for ALL /api/mcp traffic (POST initialises and sends,
 * GET opens the SSE stream, DELETE ends the session).
 */
export async function handleMcpRequest(req, res) {
  const sessionId = req.get('mcp-session-id');

  try {
    // Existing session: hand the request to its transport.
    if (sessionId && sessions.has(sessionId)) {
      return await sessions.get(sessionId).handleRequest(req, res, req.body);
    }

    // A request carrying an unknown session id is a client using a session we
    // no longer have (server restarted, or it expired). Say so precisely rather
    // than silently creating a new one, which would look like success while
    // losing the client's context.
    if (sessionId) {
      return res.status(404).json({
        success: false,
        error: { code: 'MCP_SESSION_NOT_FOUND', message: 'Unknown MCP session. Re-initialise.' },
      });
    }

    // No session id: only an initialise request may start one.
    if (req.method !== 'POST') {
      return res.status(400).json({
        success: false,
        error: { code: 'MCP_SESSION_REQUIRED', message: 'Open a session with an initialise POST first.' },
      });
    }

    /**
     * A SERVER PER SESSION, not the shared singleton.
     *
     * The SDK binds a server to one transport, so calling connect() on the
     * module singleton for each session meant the second concurrent client
     * received a 500. Building a fresh server here also lets the session carry
     * the authenticated caller's id, so tool calls arriving over HTTP are
     * audited against a real user instead of null.
     */
    const server = createMcpServer({
      userId: req.user?._id ?? null,
      sessionId: `mcp-http:${req.user?._id ?? 'anon'}`,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        logger.info({ sessionId: id, sessions: sessions.size }, 'MCP session opened');
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        logger.info({ sessionId: transport.sessionId }, 'MCP session closed');
      }
      // The per-session server goes with it; leaving it attached would leak a
      // server object for every session the process has ever served.
      server.close?.().catch(() => {});
    };

    await server.connect(transport);
    return await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err: err.message }, 'MCP transport error');
    if (res.headersSent) return undefined;
    return res.status(500).json({
      success: false,
      error: { code: 'MCP_TRANSPORT_ERROR', message: err.message },
    });
  }
}

export default handleMcpRequest;
