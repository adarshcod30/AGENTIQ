/**
 * Discovery: the structured model of a project, produced by the Discovery Agent.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D calls this the ProjectModel: the framework,
 * the API surface, the dependencies and the run commands, derived from the code.
 * It is persisted as a snapshot per discovery run, so a project keeps a history
 * and a re-discovery never overwrites what a running assessment referenced.
 *
 * Everything here is derived deterministically (AST, package.json). Inferred
 * intent, which needs the LLM, is a later phase and is not stored here.
 */
import mongoose from 'mongoose';

const endpointSchema = new mongoose.Schema({
  method: String,
  path: String,
  params: [String],
  file: String,
  line: Number,
  composed: Boolean,
}, { _id: false });

const dependencySchema = new mongoose.Schema({
  name: String,
  version: String,
  dev: Boolean,
}, { _id: false });

const discoverySchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  framework: { type: String, default: 'unknown' },
  frameworkSignals: { type: [String], default: [] },

  endpoints: { type: [endpointSchema], default: [] },
  endpointCount: { type: Number, default: 0 },

  dependencies: { type: [dependencySchema], default: [] },

  /** package.json scripts, verbatim: the run commands live here. */
  scripts: { type: mongoose.Schema.Types.Mixed, default: {} },

  /** Light config presence flags, for the deployment agent later. */
  config: {
    hasDockerfile: { type: Boolean, default: false },
    hasDockerCompose: { type: Boolean, default: false },
    hasEnvExample: { type: Boolean, default: false },
    packageManager: { type: String, default: 'npm' },
  },

  stats: {
    filesScanned: { type: Number, default: 0 },
    filesWithRoutes: { type: Number, default: 0 },
    routesFound: { type: Number, default: 0 },
    parseErrors: { type: Number, default: 0 },
  },
}, { timestamps: true });

discoverySchema.index({ projectId: 1, createdAt: -1 });

export const Discovery = mongoose.models.Discovery ?? mongoose.model('Discovery', discoverySchema);
export default Discovery;
