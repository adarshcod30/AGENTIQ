/**
 * Project: a local codebase registered for assessment.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §F. In local mode a project is a directory on
 * the user's own machine. `workspaceRoot` is the realpath of that directory,
 * resolved once by the filesystem jail at creation, so every later tool call is
 * bounded by a root that is known to exist and known to be canonical.
 *
 * The project stores WHERE the code is, never a copy of it. Discovery reads the
 * files on demand through the jail; nothing is ingested into the database.
 */
import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  name: { type: String, required: true, trim: true, maxlength: 120 },

  /** Canonical absolute path to the workspace root (realpath, set by the jail). */
  workspaceRoot: { type: String, required: true },

  /** When discovery last ran, for the project list. Null until first discovery. */
  lastDiscoveryAt: { type: Date, default: null },
}, { timestamps: true });

projectSchema.index({ userId: 1, createdAt: -1 });

/** Never leak internals the client does not need. */
projectSchema.methods.toJSON = function toJSON() {
  const { _id, name, workspaceRoot, lastDiscoveryAt, createdAt, updatedAt } = this;
  return { id: _id, name, workspaceRoot, lastDiscoveryAt, createdAt, updatedAt };
};

export const Project = mongoose.models.Project ?? mongoose.model('Project', projectSchema);
export default Project;
