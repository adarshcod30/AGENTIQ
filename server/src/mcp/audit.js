/**
 * Audit writer.
 *
 * docs/01_PRD.md F1 acceptance criterion: "Every invocation writes
 * { runId, tool, riskClass, inputHash, outcome, durationMs, ts }". The audit
 * completeness test asserts audit-row-count == tool-call-count, so a tool that
 * forgets to record itself fails the build rather than quietly under-reporting.
 */
import { createHash } from 'node:crypto';
import { AuditEvent, OUTCOME } from '../models/AuditEvent.js';
import { logger } from '../lib/logger.js';

export { OUTCOME };

/**
 * Canonical JSON: keys sorted at every level, so that {a:1,b:2} and {b:2,a:1}
 * hash identically. Without this, "was this the same call?" would depend on
 * property insertion order, which is not something a caller controls.
 */
export function canonicalise(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(',')}}`;
}

/** SHA-256 of the canonicalised input. Never the input itself. */
export function hashInput(input) {
  return createHash('sha256').update(canonicalise(input ?? null)).digest('hex');
}

/** Extracts a host for the audit row without throwing on a malformed URL. */
export function hostOf(input) {
  const candidate = input?.url ?? input?.target ?? input?.baseUrl;
  if (!candidate) return null;
  try {
    return new URL(String(candidate)).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Writes one audit row.
 *
 * Never throws. An audit failure must not turn a successful tool call into a
 * failed one, but it is logged at error level, because silent audit loss would
 * undermine the entire claim.
 */
export async function record(event) {
  try {
    return await AuditEvent.create({
      userId: event.userId ?? null,
      sessionId: event.sessionId ?? null,
      runId: event.runId ?? null,
      tool: event.tool,
      riskClass: event.riskClass,
      targetHost: event.targetHost ?? null,
      inputHash: event.inputHash,
      outcome: event.outcome,
      errorCode: event.errorCode ?? null,
      reason: event.reason ?? null,
      durationMs: event.durationMs ?? 0,
      ts: event.ts ?? new Date(),
    });
  } catch (err) {
    logger.error({ err: err.message, tool: event.tool }, 'AUDIT WRITE FAILED');
    return null;
  }
}

/**
 * Reads the audit log. Filterable per docs/02_TRD.md §10.
 * Read-only: there is deliberately no update or delete counterpart.
 */
export async function query({
  userId, runId, tool, outcome, riskClass, limit = 100, skip = 0,
} = {}) {
  const filter = {};
  if (userId) filter.userId = userId;
  if (runId) filter.runId = runId;
  if (tool) filter.tool = tool;
  if (outcome) filter.outcome = outcome;
  if (riskClass) filter.riskClass = riskClass;

  const [events, total] = await Promise.all([
    AuditEvent.find(filter).sort({ ts: -1 }).skip(skip).limit(Math.min(limit, 500)).lean(),
    AuditEvent.countDocuments(filter),
  ]);
  return { events, total };
}

export default { record, query, hashInput, canonicalise, hostOf, OUTCOME };
