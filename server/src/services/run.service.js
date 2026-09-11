/**
 * Run orchestration: the state machine in docs/03_App_Flow.md B7.
 *
 *          DRAFT
 *            │ submit
 *      AWAITING_GRANT ──────────► CANCELLED        (user denies)
 *            │ granted
 *       GENERATING ────────────► GEN_FAILED        (malformed JSON x2)
 *            │ cases valid
 *        EXECUTING ────────────► EXEC_FAILED       (partial results KEPT)
 *            │
 *   [SCANNING] → [EXPLAINING] → COMPLETE
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 *  1. EVERY TERMINAL STATE PERSISTS A TestRun. A failed run is data, not a
 *     void: a generation failure still leaves a record the user can inspect.
 *
 *  2. EXPLAINING NEVER BLOCKS COMPLETION. It is time-boxed and best-effort; a
 *     run that finishes without explanations is still complete and valid.
 */
import { TestRun, RUN_STATE, canTransition } from '../models/TestRun.js';
import { runTestingAgent } from '../agents/testing.agent.js';
import { createExplainBudget, explainRunFailures } from './explain.service.js';
import { getTool } from '../mcp/registry.js';
import { grantStore, RISK_CLASS } from '../mcp/permissions.js';
import { logger } from '../lib/logger.js';

/** Advances the run, refusing illegal transitions rather than corrupting state. */
export async function transition(run, next, note) {
  if (!canTransition(run.state, next)) {
    throw Object.assign(
      new Error(`Illegal run transition ${run.state} -> ${next}`),
      { code: 'ILLEGAL_TRANSITION' },
    );
  }
  run.state = next;
  run.stateHistory.push({ state: next, at: new Date(), note });
  await run.save();
  return run;
}

/** Marks a run terminal, stamps finishedAt, and persists. Always called. */
async function finish(run, state, error = null) {
  run.state = state;
  run.stateHistory.push({ state, at: new Date(), note: error?.message });
  run.finishedAt = new Date();
  if (error) run.error = { code: error.code ?? 'INTERNAL_ERROR', message: error.message };
  await run.save();
  return run;
}

/** Default tool runner: the real MCP registry, carrying run context for audit. */
function defaultRunTool(context) {
  return (name, input, extra = {}) => getTool(name).handler(input, { ...context, ...extra });
}

/**
 * Checks the permission the run needs BEFORE any packet leaves, so an
 * unapproved host produces AWAITING_GRANT → CANCELLED rather than traffic.
 */
export function hasRequiredGrant({ userId, sessionId, url }) {
  let host;
  try { host = new URL(url).host; } catch { return false; }
  return grantStore.check({
    userId, sessionId, riskClass: RISK_CLASS.NETWORK_READ, host,
  }).allowed;
}

/**
 * Creates and drives a run to a terminal state.
 *
 * @returns the persisted TestRun, in whatever terminal state it reached.
 */
export async function startRun({
  userId,
  sessionId = 'default',
  target,
  count = 4,
  operation = null,
  specRef = null,
  runTool,
  llm,
  explainLlm,
  maxExplanations,
}) {
  const run = await TestRun.create({
    userId,
    state: RUN_STATE.DRAFT,
    stateHistory: [{ state: RUN_STATE.DRAFT, at: new Date() }],
    target: {
      url: target.url,
      method: target.method ?? 'GET',
      description: target.description ?? '',
      intendedPublic: Boolean(target.intendedPublic),
    },
    specRef,
    grounded: Boolean(operation),
    startedAt: new Date(),
  });

  const context = { userId, sessionId, runId: String(run._id) };
  const tool = runTool ?? defaultRunTool(context);

  // ── AWAITING_GRANT ────────────────────────────────────────────────────────
  await transition(run, RUN_STATE.AWAITING_GRANT, 'permission required');
  if (!hasRequiredGrant({ userId, sessionId, url: target.url })) {
    // The permission sheet has not been answered. No packet has left.
    return finish(run, RUN_STATE.CANCELLED, Object.assign(
      new Error(`No network.read grant for ${target.url}. Approve the host to continue.`),
      { code: 'AWAITING_GRANT' },
    ));
  }

  // ── GENERATING → EXECUTING ────────────────────────────────────────────────
  await transition(run, RUN_STATE.GENERATING, 'requesting cases from the model');

  let outcome;
  try {
    outcome = await runTestingAgent({
      url: target.url,
      method: target.method ?? 'GET',
      description: target.description ?? '',
      count,
      operation,
      runTool: async (name, input, extra) => {
        // The first tool call is the moment we are genuinely executing.
        if (run.state === RUN_STATE.GENERATING) {
          await transition(run, RUN_STATE.EXECUTING, 'running generated cases');
        }
        return tool(name, input, extra);
      },
      context,
      ...(llm ? { llm } : {}),
    });
  } catch (err) {
    // GEN_FAILED is terminal and VISIBLE. Returning fabricated cases here would
    // make a broken run look like a successful one.
    if (run.state === RUN_STATE.GENERATING) {
      logger.warn({ runId: String(run._id), err: err.message }, 'run: generation failed');
      return finish(run, RUN_STATE.GEN_FAILED, err);
    }
    // Failed after execution began: partial results are kept and labelled.
    logger.warn({ runId: String(run._id), err: err.message }, 'run: execution failed');
    return finish(run, RUN_STATE.EXEC_FAILED, err);
  }

  run.summary = { ...run.summary.toObject?.() ?? run.summary, ...outcome.summary };
  run.functional = outcome.functional;
  run.generation = {
    provider: outcome.generation.provider,
    model: outcome.generation.model,
    inputTokens: outcome.generation.tokens?.input ?? 0,
    outputTokens: outcome.generation.tokens?.output ?? 0,
    costUsd: outcome.generation.costUsd,
    attempts: outcome.generation.attempts,
    generationMs: outcome.generation.generationMs,
  };
  await run.save();

  // ── EXPLAINING: best-effort, never blocking ───────────────────────────────
  const hasFailures = outcome.functional.some((r) => r.status !== 'pass');
  if (hasFailures) {
    await transition(run, RUN_STATE.EXPLAINING, 'explaining failures');

    // The budget is created HERE, per run, so there is no module-level flag
    // that can leak between runs.
    const budget = createExplainBudget({ max: maxExplanations });
    try {
      const produced = await explainRunFailures({
        results: run.functional,
        target: run.target,
        budget,
        ...(explainLlm ? { llm: explainLlm } : {}),
      });
      run.markModified('functional');
      logger.debug({ runId: String(run._id), produced }, 'explanations attached');
    } catch (err) {
      // Explanations are a nicety. Losing them must never fail a run.
      logger.debug({ err: err.message }, 'explanation stage failed, continuing');
    }
  }

  return finish(run, RUN_STATE.COMPLETE);
}

/** History for one user. Scoped by userId, never by id alone. */
export async function listRuns({ userId, limit = 50, skip = 0 }) {
  const [runs, total] = await Promise.all([
    TestRun.find({ userId }).sort({ startedAt: -1 }).skip(skip).limit(Math.min(limit, 200)).lean(),
    TestRun.countDocuments({ userId }),
  ]);
  return { runs, total };
}

/**
 * One run, scoped to its owner.
 *
 * Looking a run up by id alone would let any authenticated user read any
 * other user's run by guessing its id: a textbook IDOR. The userId filter is
 * what prevents that, and it must not be removed.
 */
export async function getRun({ userId, runId }) {
  return TestRun.findOne({ _id: runId, userId }).lean();
}

export default { startRun, listRuns, getRun, transition };
