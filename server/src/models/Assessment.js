/**
 * Assessment: one autonomous run over a project.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §C, §F. The orchestrator drives an assessment
 * through the phases and persists every transition, so a client polling the
 * document sees a live timeline and a killed worker can resume from the last
 * completed phase.
 *
 *   PENDING -> DISCOVERING -> TESTING -> SCANNING -> ANALYZING -> REPORTING
 *           -> COMPLETE            (AWAITING_INPUT pauses TESTING for a question)
 *           -> FAILED              (from any phase; partial results are kept)
 *
 * Every terminal and intermediate state is stored. A failed assessment is data,
 * not a void, the same rule the TestRun model follows.
 */
import mongoose from 'mongoose';

export const ASSESS_STATE = {
  PENDING: 'PENDING',
  DISCOVERING: 'DISCOVERING',
  TESTING: 'TESTING',
  AWAITING_INPUT: 'AWAITING_INPUT',
  SCANNING: 'SCANNING',
  ANALYZING: 'ANALYZING',
  REPORTING: 'REPORTING',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED',
};

/** Allowed forward moves. FAILED is reachable from anywhere and is not listed. */
const TRANSITIONS = {
  PENDING: ['DISCOVERING', 'FAILED'],
  DISCOVERING: ['TESTING', 'SCANNING', 'FAILED'],
  TESTING: ['AWAITING_INPUT', 'SCANNING', 'FAILED'],
  AWAITING_INPUT: ['TESTING', 'SCANNING', 'FAILED'],
  SCANNING: ['ANALYZING', 'FAILED'],
  ANALYZING: ['REPORTING', 'FAILED'],
  REPORTING: ['COMPLETE', 'FAILED'],
  COMPLETE: [],
  FAILED: [],
};

export function canTransition(from, to) {
  if (to === ASSESS_STATE.FAILED) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

const endpointResultSchema = new mongoose.Schema({
  method: String,
  path: String,
  intent: String,
  confidence: String,
  runId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestRun' },
  passed: Number,
  failed: Number,
  errored: Number,
  // Low-confidence assertions that missed. Not failures (see run_test_case): the
  // generator flagged them as guesses, so they are reported apart from `failed`.
  softFailed: Number,
  status: String, // 'complete' | 'skipped' | 'failed'
  note: String,
  /**
   * A compact record of what failed, by test category, so the guidance engine
   * can say WHY (a failing negative case means input is not validated; a failing
   * positive case means the happy path is broken) rather than only a count.
   */
  failures: {
    type: [{ category: String, name: String, reason: String, _id: false }],
    default: undefined,
  },
}, { _id: false });

const findingSchema = new mongoose.Schema({
  lane: String,
  category: String,
  severity: String,
  confidence: String,
  title: String,
  description: String,
  evidence: String,
  remediation: String,
  owasp: String,
  location: { file: String, line: Number, endpoint: String },
}, { _id: false });

const clarificationSchema = new mongoose.Schema({
  endpoint: String,
  question: String,
  answer: { type: String, default: null },
}, { _id: false });

const assessmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },

  state: { type: String, enum: Object.values(ASSESS_STATE), default: ASSESS_STATE.PENDING },
  stateHistory: [{ state: String, at: Date, note: String, _id: false }],

  discoveryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Discovery', default: null },
  baseUrl: { type: String, default: null },

  /** One entry per endpoint tested. */
  endpoints: { type: [endpointResultSchema], default: [] },

  security: {
    findings: { type: [findingSchema], default: [] },
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    notes: { type: [String], default: [] },
  },

  clarifications: { type: [clarificationSchema], default: [] },

  /** The deployment-readiness verdict (docs/10 §9 Phase 5). */
  readiness: {
    ready: { type: Boolean, default: false },
    blockers: { type: [String], default: [] },
    warnings: { type: [String], default: [] },
  },

  /** The consolidated report, rendered in the REPORTING phase. */
  report: { type: mongoose.Schema.Types.Mixed, default: null },

  error: { code: String, message: String },

  startedAt: { type: Date, default: Date.now },
  finishedAt: { type: Date, default: null },
}, { timestamps: true });

assessmentSchema.index({ userId: 1, createdAt: -1 });
assessmentSchema.index({ projectId: 1, createdAt: -1 });

export const Assessment = mongoose.models.Assessment ?? mongoose.model('Assessment', assessmentSchema);
export default Assessment;
