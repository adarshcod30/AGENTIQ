/**
 * Discovery orchestration: register a project, then discover its model.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §F, Phase 1. This service is the seam between
 * the HTTP layer and the tool layer. It creates the filesystem jail from the
 * project's workspace root and injects that root into the tool context, so the
 * discovery agent (which has no I/O) drives the fs tools inside the jail.
 *
 * The workspace root is validated and canonicalised by the jail at project
 * creation, so a path that does not exist, or is not a directory, is refused
 * with a clear error before any project row is written.
 */
import { createJail, FsJailError } from '../mcp/fsJail.js';
import { env } from '../config/env.js';
import { validateUrl, EgressError } from '../mcp/egress.js';
import { cloneRepo, normalizeGithubUrl, GitError } from './git.service.js';
import { getConnectionToken } from './connections.service.js';
import { cloneQueue } from '../lib/jobQueue.js';
import { readTextInJail } from '../mcp/analysis/workspace.js';
import { getTool } from '../mcp/registry.js';
import { runDiscoveryAgent } from '../agents/discovery.agent.js';
import { Project } from '../models/Project.js';
import { Discovery } from '../models/Discovery.js';
import { logger } from '../lib/logger.js';

/** Wraps a validation failure so the route can answer 400 rather than 500. */
export class DiscoveryError extends Error {
  constructor(message, code = 'DISCOVERY_ERROR', status = 400) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Registers a project. The jail both validates the workspace exists and returns
 * its canonical realpath, which is what we store, so later tool calls are bound
 * to a root that cannot move under a symlink.
 */
export async function createProject({
  userId, name, workspaceRoot, targetUrl, repoUrl, runtimeEnv, startScript, scheduleClone = true,
}) {
  let root;
  let normalizedRepo = null; // a GitHub project: validated now, cloned in the background
  if (workspaceRoot) {
    // On the shared hosted deployment a "folder" is on the user's own laptop,
    // which this server cannot reach; resolving it against the server's own
    // filesystem is meaningless at best and, since the jail would be rooted at a
    // server directory the user names, a way to read the server's files at worst.
    // Refuse it and steer them to a deployed URL or a public GitHub repo.
    if (env.HOSTED) {
      throw new DiscoveryError(
        'A folder path only works when you run AGENTIQ on your own machine. On the hosted '
        + 'site, assess a deployed URL or a public GitHub repo instead.',
        'FOLDER_NOT_ALLOWED_HOSTED', 400,
      );
    }
    try {
      root = createJail(workspaceRoot).root;
    } catch (err) {
      if (err instanceof FsJailError) throw new DiscoveryError(err.message, 'INVALID_WORKSPACE', 400);
      throw err;
    }
  } else if (repoUrl) {
    // Validate the URL now (cheap, no network) so a bad URL fails the request
    // immediately. The clone itself runs in the background: the project starts
    // in 'cloning' and flips to 'ready' or 'failed' when the job finishes.
    try {
      normalizedRepo = normalizeGithubUrl(repoUrl);
    } catch (err) {
      if (err instanceof GitError) throw new DiscoveryError(err.message, err.code, 400);
      throw err;
    }
  }
  let url;
  if (targetUrl) {
    try {
      // The same guard the probes use: rejects a bad scheme and, outside dev,
      // an internal host, so a project can never be pointed at the metadata IP.
      url = validateUrl(targetUrl).toString();
    } catch (err) {
      if (err instanceof EgressError) throw new DiscoveryError(`That deployed URL cannot be used: ${err.message}`, 'INVALID_TARGET_URL', 400);
      throw err;
    }
  }
  if (!root && !url && !normalizedRepo) {
    throw new DiscoveryError('Provide a project folder, a deployed URL, or a GitHub repo', 'NO_TARGET', 400);
  }
  const hasEnv = runtimeEnv && Object.keys(runtimeEnv).length > 0;
  const cloning = Boolean(normalizedRepo && !root); // a repo with no local folder yet
  const project = await Project.create({
    userId, name,
    trusted: !cloning, // cloned code is untrusted; a folder or URL project is trusted
    ...(root ? { workspaceRoot: root } : {}),
    ...(url ? { targetUrl: url } : {}),
    ...(normalizedRepo ? { repoUrl: normalizedRepo } : {}),
    ...(cloning ? { cloneStatus: 'cloning' } : {}),
    ...(hasEnv ? { runtimeEnv } : {}),
    ...(startScript && startScript.trim() ? { startScript: startScript.trim() } : {}),
  });
  if (cloning && scheduleClone) {
    cloneQueue.enqueue(() => runCloneJob({ projectId: project._id, repoUrl: normalizedRepo, userId })
      .catch((err) => logger.error({ err: err.message }, 'clone job crashed')));
  }
  return project;
}

/**
 * Runs a project's background clone. On success the workspace becomes available
 * and the project flips to 'ready'; on failure it flips to 'failed' with the
 * reason, so the UI shows it instead of the project hanging. `clone` is
 * injectable so tests can drive both paths without touching the network.
 */
export async function runCloneJob({ projectId, repoUrl, userId = null, clone = cloneRepo }) {
  try {
    // Use the user's own GitHub token when they have connected one, so a private
    // repo clones; absent, it is a public clone.
    const token = userId ? await getConnectionToken({ userId, provider: 'github' }).catch(() => null) : null;
    const cloned = await clone({ url: repoUrl, token });
    await Project.updateOne(
      { _id: projectId },
      { $set: { workspaceRoot: cloned.path, cloneStatus: 'ready' }, $unset: { cloneError: '' } },
    );
    logger.info({ projectId: String(projectId) }, 'clone complete');
  } catch (err) {
    const message = err instanceof GitError ? err.message : (err.message ?? 'clone failed');
    await Project.updateOne({ _id: projectId }, { $set: { cloneStatus: 'failed', cloneError: message } });
    logger.warn({ projectId: String(projectId), err: message }, 'clone job failed');
  }
}

/**
 * Updates a project's opt-in runtime config: the environment the app needs to
 * start, and optionally the npm script that starts it. Owner-scoped. Each field
 * is applied only when the caller sends it (`undefined` means "leave as is"), so
 * saving env does not wipe the start script and vice versa. Returns the env key
 * NAMES only, never the values, so the secrets never travel back out.
 */
export async function updateProjectEnv({ userId, projectId, runtimeEnv, startScript, targetUrl }) {
  const project = await Project.findOne({ _id: projectId, userId }).select('+runtimeEnv');
  if (!project) throw new DiscoveryError('Project not found', 'NOT_FOUND', 404);
  if (runtimeEnv !== undefined) {
    const hasEnv = runtimeEnv && Object.keys(runtimeEnv).length > 0;
    project.runtimeEnv = hasEnv ? runtimeEnv : undefined;
  }
  if (startScript !== undefined) {
    const trimmed = typeof startScript === 'string' ? startScript.trim() : '';
    project.startScript = trimmed ? trimmed : undefined;
  }
  if (targetUrl !== undefined) {
    const t = typeof targetUrl === 'string' ? targetUrl.trim() : '';
    if (t) {
      try {
        project.targetUrl = validateUrl(t).toString();
      } catch (err) {
        if (err instanceof EgressError) throw new DiscoveryError(`That deployed URL cannot be used: ${err.message}`, 'INVALID_TARGET_URL', 400);
        throw err;
      }
    } else {
      if (!project.workspaceRoot) throw new DiscoveryError('Cannot remove the URL: the project has no folder to fall back on', 'NO_TARGET', 400);
      project.targetUrl = undefined;
    }
  }
  await project.save();
  const keys = project.runtimeEnv ? [...project.runtimeEnv.keys()] : [];
  return {
    id: project._id, runtimeEnvKeys: keys,
    startScript: project.startScript ?? null, targetUrl: project.targetUrl ?? null,
  };
}

/** KEY=VALUE per line -> object. Blank lines and #comments ignored; surrounding
 *  quotes stripped. Mirrors the frontend parser and dotenv's basic behaviour. */
function parseDotenv(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

/** Only env files may be imported, never an arbitrary path. */
const ENV_FILE_RE = /^\.env(\.[\w.-]+)?$/;

/**
 * Reads the project's own .env file from its workspace and stores it as the
 * runtime env, so the user does not retype it (the "access" toggle in the UI).
 * The file is read THROUGH the jail, so it must sit inside the workspace, and the
 * values are stored server-side exactly like a hand-entered env: they never
 * travel back to the browser. Only a `.env` (or `.env.<name>`) file is allowed.
 */
export async function importEnvFromFile({ userId, projectId, file = '.env' }) {
  if (!ENV_FILE_RE.test(file)) throw new DiscoveryError('Only a .env file can be imported', 'BAD_ENV_FILE', 400);
  const project = await Project.findOne({ _id: projectId, userId }).select('+runtimeEnv');
  if (!project) throw new DiscoveryError('Project not found', 'NOT_FOUND', 404);
  if (!project.workspaceRoot) {
    throw new DiscoveryError('This project has no local folder to read a .env from', 'NO_SOURCE', 400);
  }
  let jail;
  try {
    jail = createJail(project.workspaceRoot);
  } catch {
    throw new DiscoveryError(`The project workspace is no longer available: ${project.workspaceRoot}`, 'WORKSPACE_GONE', 409);
  }
  const text = readTextInJail(jail, file, 256 * 1024);
  if (text === null) throw new DiscoveryError(`No ${file} file found in the project folder`, 'ENV_FILE_NOT_FOUND', 404);
  const parsed = parseDotenv(text);
  if (Object.keys(parsed).length === 0) throw new DiscoveryError(`${file} has no KEY=VALUE lines`, 'ENV_FILE_EMPTY', 400);
  project.runtimeEnv = parsed;
  await project.save();
  return { id: project._id, runtimeEnvKeys: Object.keys(parsed), imported: Object.keys(parsed).length, file };
}

/** The tool runner, carrying the project workspace so fs tools stay in the jail. */
function toolRunner(context) {
  return (name, input, extra = {}) => getTool(name).handler(input, { ...context, ...extra });
}

/**
 * Runs discovery against a registered project and persists the result.
 *
 * @returns the persisted Discovery document.
 */
export async function discoverProject({ userId, projectId, sessionId = 'discovery' }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new DiscoveryError('Project not found', 'NOT_FOUND', 404);

  // A URL-only project has no source to read: discovery is a folder operation.
  if (!project.workspaceRoot) {
    throw new DiscoveryError(
      'This project has no local source to discover; it is assessed by its deployed URL.',
      'NO_SOURCE', 400,
    );
  }

  // Re-create the jail from the stored root. If the directory has since been
  // moved or deleted, fail clearly rather than half-discovering nothing.
  try {
    createJail(project.workspaceRoot);
  } catch {
    throw new DiscoveryError(
      `The project workspace is no longer available: ${project.workspaceRoot}`,
      'WORKSPACE_GONE',
      409,
    );
  }

  const context = {
    userId: String(userId),
    sessionId,
    workspaceRoot: project.workspaceRoot,
  };

  const model = await runDiscoveryAgent({ runTool: toolRunner(context), context });

  const discovery = await Discovery.create({ projectId: project._id, userId, ...model });
  project.lastDiscoveryAt = new Date();
  await project.save();

  logger.info(
    { projectId: String(project._id), endpoints: model.endpointCount, framework: model.framework },
    'discovery complete',
  );
  return discovery;
}

/** A user's projects, newest first. Scoped by userId, never by id alone. */
export async function listProjects({ userId }) {
  const projects = await Project.find({ userId }).sort({ createdAt: -1 }).select('+runtimeEnv').lean();
  // Expose only the KEY names of the runtime env, never the values.
  return projects.map(({ runtimeEnv, ...p }) => ({
    ...p,
    runtimeEnvKeys: runtimeEnv ? Object.keys(runtimeEnv) : [],
  }));
}

/** One project with its latest discovery, scoped to the owner. */
export async function getProject({ userId, projectId }) {
  const project = await Project.findOne({ _id: projectId, userId }).select('+runtimeEnv');
  if (!project) return null;
  const latest = await Discovery.findOne({ projectId, userId }).sort({ createdAt: -1 }).lean();
  const runtimeEnvKeys = project.runtimeEnv ? [...project.runtimeEnv.keys()] : [];
  return { project: { ...project.toJSON(), runtimeEnvKeys }, discovery: latest };
}

export default { createProject, updateProjectEnv, discoverProject, listProjects, getProject };
