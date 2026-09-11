#!/usr/bin/env node
/**
 * stdio entrypoint: lets an external MCP client drive AGENTIQ's tools.
 *
 * docs/02_TRD.md §5.4. AGENTIQ is not merely *built on* MCP, it *is* an MCP
 * server that another agent can connect to and call.
 *
 *   npm --workspace server run mcp:stdio
 *
 * Claude Desktop / IDE config:
 *   {
 *     "mcpServers": {
 *       "agentiq": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/AGENTIQ/server/src/mcp/stdio.js"]
 *       }
 *     }
 *   }
 *
 * IMPORTANT: stdout is the protocol channel.
 * Anything written to stdout that is not a JSON-RPC message corrupts the
 * stream and the client disconnects with a parse error. All logging must go to
 * stderr. lib/logger.js is silenced below for exactly this reason; it is the
 * single most common way to break a stdio MCP server.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadDotenv } from '../config/env.js';

loadDotenv();

// Silence pino before anything can write to stdout.
process.env.LOG_LEVEL = 'silent';

const { mcp } = await import('./registry.js');
const { registerAllTools } = await import('./tools/index.js');
const { connectDB } = await import('../lib/db.js');

const tools = await registerAllTools();
process.stderr.write(`AGENTIQ MCP server: ${tools.length} tools registered\n`);

// The database is optional here. An MCP client must be able to LIST tools even
// with no DB reachable; tools that need one fail individually with a typed
// error rather than preventing the server from starting at all.
if (process.env.MONGO_URI) {
  await connectDB().catch((err) => {
    process.stderr.write(`MongoDB unavailable (${err.message}): audit rows will not persist\n`);
  });
}

const transport = new StdioServerTransport();
await mcp.connect(transport);

process.stderr.write('AGENTIQ MCP server ready on stdio\n');

process.on('SIGINT', async () => {
  await mcp.close().catch(() => {});
  process.exit(0);
});
