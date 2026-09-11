/**
 * TestRun: the record of one run, in every terminal state.
 *
 * docs/02_TRD.md §9 and the state machine in docs/03_App_Flow.md B7.
 *
 * THE RULE THAT SHAPES THIS MODEL: every terminal state persists a TestRun.
 * A failed run is data, not a void. Storing only successes would leave a user
 * who hit a generation failure with nothing in history and no way to show
 * anyone what happened. Partial results are kept and labelled, never discarded.
 */
import mongoose from 'mongoose';

/** docs/03_App_Flow.md B7. Terminal states are marked. */
export const RUN_STATE = {
  DRAFT: 'DRAFT',
  AWAITING_GRANT: 'AWAITING_GRANT',
  CANCELLED: 'CANCELLED',       // terminal
  GENERATING: 'GENERATING',
  GEN_FAILED: 'GEN_FAILED',     // terminal: visible error, never a fake pass
  EXECUTING: 'EXECUTING',
  EXEC_FAILED: 'EXEC_FAILED',   // terminal: partial results kept
  SCANNING: 'SCANNING',
  EXPLAINING: 'EXPLAINING',
  COMPLETE: 'COMPLETE',         // terminal
};

export const RUN_STATES = Object.values(RUN_STATE);
export const TERMINAL_STATES = [
  RUN_STATE.CANCELLED, RUN_STATE.GEN_FAILED, RUN_STATE.EXEC_FAILED, RUN_STATE.COMPLETE,
];

/** Legal transitions. Enforced so an impossible run cannot be persisted. */
export const TRANSITIONS = {
  [RUN_STATE.DRAFT]: [RUN_STATE.AWAITING_GRANT, RUN_STATE.GENERATING, RUN_STATE.CANCELLED],
  [RUN_STATE.AWAITING_GRANT]: [RUN_STATE.GENERATING, RUN_STATE.CANCELLED],
  [RUN_STATE.GENERATING]: [RUN_STATE.EXECUTING, RUN_STATE.GEN_FAILED, RUN_STATE.CANCELLED],
  [RUN_STATE.EXECUTING]: [
    RUN_STATE.SCANNING, RUN_STATE.EXPLAINING, RUN_STATE.COMPLETE, RUN_STATE.EXEC_FAILED,
  ],
  [RUN_STATE.SCANNING]: [RUN_STATE.EXPLAINING, RUN_STATE.COMPLETE],
  [RUN_STATE.EXPLAINING]: [RUN_STATE.COMPLETE],
  [RUN_STATE.CANCELLED]: [],
  [RUN_STATE.GEN_FAILED]: [],
  [RUN_STATE.EXEC_FAILED]: [],
  [RUN_STATE.COMPLETE]: [],
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

const assertionResultSchema = new mongoose.Schema({
  kind: String,
  expected: String,
  actual: String,
  pass: Boolean,
}, { _id: false });

const functionalResultSchema = new mongoose.Schema({
  name: String,
  intent: String,
  category: String,
  status: { type: String, enum: ['pass', 'fail', 'error'] },
  httpStatus: Number,
  responseTimeMs: Number,
  assertions: [assertionResultSchema],
  error: String,
  // Populated only for failures, and only when EXPLAINING succeeds in time.
  explanation: String,
}, { _id: false });

const findingSchema = new mongoose.Schema({
  family: String,
  owasp: String,
  severity: { type: String, enum: ['critical', 'high', 'medium', 'low'] },
  vulnerable: Boolean,
  payload: String,
  signal: String,
  baseline: String,
  explanation: String,
  remediation: String,
}, { _id: false });

const testRunSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  state: { type: String, enum: RUN_STATES, default: RUN_STATE.DRAFT, index: true },
  /** Every state the run passed through, with timestamps: the trace a user sees. */
  stateHistory: [{ state: String, at: Date, note: String, _id: false }],

  target: {
    url: { type: String, required: true },
    method: { type: String, default: 'GET' },
    description: String,
    /** Load-bearing: an anonymous 200 from a deliberately public endpoint is
     *  CORRECT. Without this flag the auth probe would flag every public API. */
    intendedPublic: { type: Boolean, default: false },
  },

  specRef: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiSpec', default: null },
  grounded: { type: Boolean, default: false },

  summary: {
    totalTests: { type: Number, default: 0 },
    passed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    errored: { type: Number, default: 0 },
    discarded: { type: Number, default: 0 },
    assertionsEvaluated: { type: Number, default: 0 },
    findings: {
      critical: { type: Number, default: 0 },
      high: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      low: { type: Number, default: 0 },
    },
  },

  functional: [functionalResultSchema],
  security: [findingSchema],

  generation: {
    provider: String,
    model: String,
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    costUsd: Number,
    attempts: Number,
    generationMs: Number,
  },

  /** Present on GEN_FAILED / EXEC_FAILED. A named failure, not a stack trace. */
  error: {
    code: String,
    message: String,
  },

  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
}, { timestamps: true });

testRunSchema.index({ userId: 1, startedAt: -1 });

testRunSchema.virtual('isTerminal').get(function isTerminal() {
  return TERMINAL_STATES.includes(this.state);
});

testRunSchema.virtual('durationMs').get(function durationMs() {
  if (!this.finishedAt) return null;
  return this.finishedAt.getTime() - this.startedAt.getTime();
});

testRunSchema.set('toJSON', { virtuals: true });

export const TestRun = mongoose.models.TestRun ?? mongoose.model('TestRun', testRunSchema, 'testruns');
export default TestRun;
