/**
 * Deployment: docs/02_TRD.md §9.
 *
 * The record that makes F5 a contribution rather than a button: it links a
 * deployment to the test run and security scan that were executed against the
 * resulting live URL. docs/01_PRD.md F5: "A deployment that verifies itself is
 * a genuine contribution; a deploy button is not."
 */
import mongoose from 'mongoose';

export const DEPLOY_STATE = {
  PREFLIGHT: 'PREFLIGHT',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED', // terminal
  DEPLOYING: 'DEPLOYING',
  DEPLOY_FAILED: 'DEPLOY_FAILED',       // terminal
  VERIFYING: 'VERIFYING',
  COMPLETE: 'COMPLETE',                 // terminal
};

export const DEPLOY_STATES = Object.values(DEPLOY_STATE);

const preflightCheckSchema = new mongoose.Schema({
  name: String,
  status: { type: String, enum: ['pass', 'warn', 'fail'] },
  detail: String,
}, { _id: false });

const deploymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  provider: { type: String, default: 'render' },
  repo: { type: String, required: true },
  branch: { type: String, default: 'main' },
  serviceName: { type: String, required: true },

  state: { type: String, enum: DEPLOY_STATES, default: DEPLOY_STATE.PREFLIGHT, index: true },
  stateHistory: [{ state: String, at: Date, note: String, _id: false }],

  preflight: { type: [preflightCheckSchema], default: [] },

  /** Provider identifiers. NEVER the API key. */
  serviceId: { type: String, default: null },
  deployId: { type: String, default: null },
  liveUrl: { type: String, default: null },

  /**
   * Failure diagnosis (deploy/diagnose.js): classification, explanation, a
   * proposed fix, and a `proposal` (deploy/retry.js) saying whether AGENTIQ can
   * retry this by setting config, or whether the user must change code first.
   */
  diagnosis: { type: mongoose.Schema.Types.Mixed, default: null },

  /** When this deployment is a retry, the deployment it was retrying. */
  retryOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Deployment', default: null },

  /**
   * The whole point of F5: the runs executed against the LIVE url after the
   * deploy succeeded. A deployment with no post-deploy verification is just a
   * deploy button.
   */
  postDeployRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'TestRun', default: null },
  verification: {
    testsPassed: Number,
    testsTotal: Number,
    findings: Number,
    healthy: Boolean,
  },

  error: { code: String, message: String },

  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
}, { timestamps: true });

deploymentSchema.index({ userId: 1, startedAt: -1 });

/**
 * Defence in depth: even if a caller forgets to project, serialising a
 * deployment must never emit a provider credential. Nothing writes an apiKey
 * field today; this makes that stay true.
 */
deploymentSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.apiKey;
    delete ret.__v;
    return ret;
  },
});

export const Deployment =
  mongoose.models.Deployment ?? mongoose.model('Deployment', deploymentSchema, 'deployments');
export default Deployment;
