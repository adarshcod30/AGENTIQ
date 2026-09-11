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
export async function createProject({ userId, name, workspaceRoot, runtimeEnv }) {
  let jail;
  try {
    jail = createJail(workspaceRoot);
  } catch (err) {
    if (err instanceof FsJailError) {
      throw new DiscoveryError(err.message, 'INVALID_WORKSPACE', 400);
    }
    throw err;
  }
  const hasEnv = runtimeEnv && Object.keys(runtimeEnv).length > 0;
  return Project.create({ userId, name, workspaceRoot: jail.root, ...(hasEnv ? { runtimeEnv } : {}) });
}

/**
 * Replaces a project's opt-in runtime environment. Owner-scoped. Returns the key
 * NAMES only, never the values, so a caller can confirm what is set without the
 * secrets travelling back out.
 */
export async function updateProjectEnv({ userId, projectId, runtimeEnv }) {
  const project = await Project.findOne({ _id: projectId, userId }).select('+runtimeEnv');
  if (!project) throw new DiscoveryError('Project not found', 'NOT_FOUND', 404);
  const hasEnv = runtimeEnv && Object.keys(runtimeEnv).length > 0;
  project.runtimeEnv = hasEnv ? runtimeEnv : undefined;
  await project.save();
  return { id: project._id, runtimeEnvKeys: hasEnv ? Object.keys(runtimeEnv) : [] };
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
