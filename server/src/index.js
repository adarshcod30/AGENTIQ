/**
 * Boot: validate config → connect to MongoDB → listen.
 *
 * The only file that is allowed to exit the process. Everything it uses is
 * importable without side effects, which is what makes the app testable.
 */
import { loadEnv } from './config/env.js';
import { connectDB, disconnectDB } from './lib/db.js';
import { logger } from './lib/logger.js';

// Prints the set/missing table and exits non-zero if a required var is absent.
const env = loadEnv();

// Registering the tools is a side effect of importing them, so it happens
// before the app is built and /api/mcp/tools can never serve an empty registry.
const { registerAllTools } = await import('./mcp/tools/index.js');
const tools = await registerAllTools();
logger.info(`MCP registry: ${tools.length} tools registered`);

/**
 * Say out loud which LLM providers are actually usable.
 *
 * providerOrder() silently DROPS a provider that is named but unconfigured, so
 * LLM_PRIMARY=groq with LLM_FALLBACK=bedrock and no BEDROCK_MODEL_ID resolves
 * to ['groq']: a chain with no fallback at all, which reads as configured.
 * That went unnoticed until an evaluation run was traced back to the wrong
 * provider. A named-but-unavailable provider is now a warning, and a
 * single-provider chain says plainly that there is nothing to fall back to.
 */
const { providerOrder, availableProviders } = await import('./services/llm.js');
const usable = providerOrder();
const available = availableProviders();
for (const named of [env.LLM_PRIMARY, env.LLM_FALLBACK]) {
  if (named && !available[named]) {
    logger.warn(
      { provider: named },
      `LLM provider "${named}" is named in the configuration but is not usable: its ` +
      'credentials or model id are missing, so it has been dropped from the chain.',
    );
  }
}
if (usable.length === 0) {
  logger.error('No LLM provider is usable. Test generation will fail on every run.');
} else if (usable.length === 1) {
  logger.warn(`LLM chain: ${usable[0]} only; there is NO fallback if it fails.`);
} else {
  logger.info(`LLM chain: ${usable.join(' -> ')}`);
}

const { app } = await import('./app.js');

try {
  await connectDB();
} catch (err) {
  logger.error(
    { err: err.message },
    'Could not connect to MongoDB. Check MONGO_URI, and that this IP is allowed in Atlas.',
  );
  process.exit(1);
}

// Restore permission grants that outlived a restart, and start writing new ones
// through to the database. Boot-only: tests drive the store purely in memory.
const { grantStore } = await import('./mcp/permissions.js');
const { attachGrantPersistence } = await import('./mcp/grantPersistence.js');
await attachGrantPersistence(grantStore);

const server = app.listen(env.PORT, () => {
  logger.info(`AGENTIQ server listening on http://localhost:${env.PORT}`);
  logger.info(`Health check: http://localhost:${env.PORT}/api/health`);
});

/** Close the port and the DB cleanly so nodemon restarts do not leak handles. */
async function shutdown(signal) {
  logger.info(`${signal} received: shutting down`);
  server?.close();
  await disconnectDB().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});
