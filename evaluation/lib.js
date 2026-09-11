/**
 * Shared plumbing for the evaluation harness.
 *
 * The harness drives the REAL agents through the REAL MCP tool layer: the same
 * permission gate, egress guard and audit writer the product uses. Nothing here
 * shortcuts to an HTTP client. If it did, the evaluation would be measuring a
 * different system from the one being described.
 */
import { env } from '../server/src/config/env.js';
import { registerAllTools } from '../server/src/mcp/tools/index.js';
import { getTool } from '../server/src/mcp/registry.js';
import { grantStore, RISK_CLASS } from '../server/src/mcp/permissions.js';

export const EVAL_SESSION = 'evaluation-harness';
export const CONTEXT = { userId: null, sessionId: EVAL_SESSION, runId: null };

/** Starts an app on an ephemeral loopback port. */
export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * Prepares the tool layer.
 *
 * The fixtures live on loopback, which the egress guard blocks by default. This
 * is precisely what ALLOW_PRIVATE_TARGETS exists for, and config/env.js refuses
 * it outright when NODE_ENV=production.
 */
export async function prepareTools() {
  await registerAllTools();
  env.ALLOW_PRIVATE_TARGETS = true;
}

export function restoreTools() {
  env.ALLOW_PRIVATE_TARGETS = false;
}

/**
 * Grants the classes a scan needs for one host.
 *
 * The harness grants network.probe explicitly and deliberately: it is measuring
 * a scanner against hosts it started itself, on loopback, seconds ago. That is
 * exactly the situation the grant model is designed to permit, and it stays an
 * explicit act here rather than a default, for the same reason it does in the UI.
 */
export function grantFor(url) {
  const host = new URL(url).host;
  for (const riskClass of [RISK_CLASS.NETWORK_READ, RISK_CLASS.NETWORK_PROBE]) {
    grantStore.grant({ userId: null, sessionId: EVAL_SESSION, riskClass, host });
  }
  return host;
}

export const runTool = (name, input, extra = {}) =>
  getTool(name).handler(input, { ...CONTEXT, ...extra });

/** Rounds to `places`, returning null rather than NaN for an empty denominator. */
export function ratio(numerator, denominator, places = 3) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(places));
}

export const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

/** Wall-clock helper that also returns the value. */
export async function timed(fn) {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

/* ── Database ─────────────────────────────────────────────────────────────── */

/**
 * The harness needs a database because EVERY tool call writes an audit row, and
 * without a connection mongoose buffers each insert until it times out: ten
 * seconds per tool call, which turns a two-minute run into a twenty-minute one.
 *
 * It connects to a DEDICATED database (`agentiq_eval`), dropped at the start of
 * every run, so an evaluation never mixes its rows into the application's data
 * and can never be influenced by a previous run's state.
 *
 * Note it goes through the server's own connectDB rather than importing
 * mongoose here: mongoose is a dependency of the `server` workspace and is not
 * resolvable from the repository root, where this file lives.
 *
 * Keeping the audit writes real rather than stubbing them out is deliberate:
 * the row count at the end is evidence that the measurement genuinely went
 * through the guarded tool layer, and it is reported in the evaluation.
 */
export async function connectEvalDb() {
  if (!env.MONGO_URI) throw new Error('MONGO_URI is not set, so audit rows cannot be written.');
  const { connectDB } = await import('../server/src/lib/db.js');
  await connectDB(env.MONGO_URI, { dbName: 'agentiq_eval', serverSelectionTimeoutMS: 20_000 });

  // Reached through a model so mongoose never has to resolve from the root.
  const { AuditEvent } = await import('../server/src/models/AuditEvent.js');
  await AuditEvent.db.dropDatabase();
}

export async function auditRowCount() {
  const { AuditEvent } = await import('../server/src/models/AuditEvent.js');
  const [total, byOutcome] = await Promise.all([
    AuditEvent.countDocuments({}),
    AuditEvent.aggregate([{ $group: { _id: '$outcome', n: { $sum: 1 } } }]),
  ]);
  return { total, byOutcome: Object.fromEntries(byOutcome.map((r) => [r._id, r.n])) };
}

export async function disconnectEvalDb() {
  const { disconnectDB } = await import('../server/src/lib/db.js');
  await disconnectDB();
}
