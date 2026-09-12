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
import { validateUrl, EgressError } from '../mcp/egress.js';
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
export async function createProject({ userId, name, workspaceRoot, targetUrl, runtimeEnv, startScript }) {
  let root;
  if (workspaceRoot) {
    try {
      root = createJail(workspaceRoot).root;
    } catch (err) {
      if (err instanceof FsJailError) throw new DiscoveryError(err.message, 'INVALID_WORKSPACE', 400);
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
  if (!root && !url) {
    throw new DiscoveryError('Provide a project folder or a deployed URL', 'NO_TARGET', 400);
  }
  const hasEnv = runtimeEnv && Object.keys(runtimeEnv).length > 0;
  return Project.create({
    userId, name,
    ...(root ? { workspaceRoot: root } : {}),
    ...(url ? { targetUrl: url } : {}),
    ...(hasEnv ? { runtimeEnv } : {}),
    ...(startScript && startScript.trim() ? { startScript: startScript.trim() } : {}),
  });
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
