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

  /**
   * Canonical absolute path to the workspace root (realpath, set by the jail).
   * Optional: a project can instead be a deployed URL with no local source, in
   * which case discovery and the static scans are skipped and only the live
   * security scan runs.
   */
  workspaceRoot: { type: String },

  /**
   * A deployed base URL to assess, e.g. https://my-app.vercel.app. When set, the
   * assessment points its security scan at this live URL instead of starting the
   * app locally, and skips functional tests so it never changes live data.
   * Validated as a public http(s) URL at creation (the egress guard's rules).
   */
  targetUrl: { type: String, default: undefined, trim: true },

  /** When discovery last ran, for the project list. Null until first discovery. */
  lastDiscoveryAt: { type: Date, default: null },

  /**
   * Opt-in runtime environment for starting the app under test (a database URL,
   * a secret). It can hold real credentials, so it is ENCRYPTED at rest exactly
   * like a provider key or a deploy token: the whole KEY=VALUE map is AES-256-GCM
   * encrypted into this one blob (services/crypto.service.js). `select: false`
   * keeps it out of every query by default, so it is never loaded, never
   * serialised, and never sent to the browser; the assessment worker asks for it
   * explicitly and decrypts it only in memory to start the app. A database dump
   * therefore never exposes anyone's runtime secrets in the clear.
   */
  runtimeEnvEnc: { type: String, default: undefined, select: false },

  /**
   * The env variable NAMES only (e.g. ['MONGO_URI', 'JWT_SECRET']). Not a secret,
   * so unlike the encrypted blob it is selected by default and shown in the UI as
   * an "env: MONGO_URI, JWT_SECRET" chip, letting the list render without ever
   * touching the ciphertext.
   */
  runtimeEnvKeys: { type: [String], default: undefined },

  /**
   * Optional npm script that starts the app under test, e.g. "dev:backend".
   * When the root dev/start/serve script does not boot a single server (a
   * monorepo, an unusual name), the user names the right one here and the
   * sandbox runs `npm run <startScript>`. It is a script NAME, not a shell
   * command, so it stays inside the allowlisted runner. Not a secret, so unlike
   * runtimeEnv it is returned to the UI.
   */
  startScript: { type: String, default: undefined, trim: true, maxlength: 60 },

  /** If the workspace was cloned from GitHub, the source repo URL (for display). */
  repoUrl: { type: String, default: undefined, trim: true },

  /**
   * Whether the code in the workspace is the user's own (true) or was pulled from
   * an external source such as a cloned GitHub repo (false). An untrusted project
   * is never started, so its scripts never run: it gets discovery and the static
   * scans only. Defaults true for a folder the user pointed at themselves.
   */
  trusted: { type: Boolean, default: true },

  /**
   * For a GitHub project, the state of its background clone: 'cloning' while the
   * repo is being fetched, 'ready' once its workspace is available, 'failed' if
   * the clone did not complete (cloneError says why). Folder and URL projects are
   * 'ready' from creation.
   */
  cloneStatus: { type: String, enum: ['ready', 'cloning', 'failed'], default: 'ready' },
  cloneError: { type: String, default: undefined },
}, { timestamps: true });

projectSchema.index({ userId: 1, createdAt: -1 });

/** A project must point at something: a local folder, a deployed URL, or both. */
projectSchema.pre('validate', function requireTarget() {
  if (!this.workspaceRoot && !this.targetUrl && !this.repoUrl) {
    this.invalidate('workspaceRoot', 'A project needs a workspace folder, a deployed URL, or a GitHub repo');
  }
});

/** Never leak internals the client does not need. The encrypted runtime env is
 *  select:false and absent here by construction; only its key names are exposed. */
projectSchema.methods.toJSON = function toJSON() {
  const {
    _id, name, workspaceRoot, targetUrl, repoUrl, trusted, cloneStatus, cloneError,
    startScript, runtimeEnvKeys, lastDiscoveryAt, createdAt, updatedAt,
  } = this;
  return {
    id: _id,
    name,
    workspaceRoot: workspaceRoot ?? null,
    targetUrl: targetUrl ?? null,
    repoUrl: repoUrl ?? null,
    trusted: trusted !== false,
    cloneStatus: cloneStatus ?? 'ready',
    cloneError: cloneError ?? null,
    startScript: startScript ?? null,
    runtimeEnvKeys: runtimeEnvKeys ?? [],
    lastDiscoveryAt,
    createdAt,
    updatedAt,
  };
};

export const Project = mongoose.models.Project ?? mongoose.model('Project', projectSchema);
export default Project;
