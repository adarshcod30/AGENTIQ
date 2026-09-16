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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createJail, FsJailError } from '../mcp/fsJail.js';
import { env } from '../config/env.js';
import { encryptSecret, decryptSecret } from './crypto.service.js';
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
 * Turns a runtime-env map into the Project fields to store: the AES-GCM
 * encrypted blob (a secret) and the key names (not a secret). An empty or absent
 * map clears both. This is the single place runtime env is encrypted for storage.
 */
export function runtimeEnvFields(map) {
  const has = map && Object.keys(map).length > 0;
  return {
    runtimeEnvEnc: has ? encryptSecret(JSON.stringify(map)) : undefined,
    runtimeEnvKeys: has ? Object.keys(map) : undefined,
  };
}

/** Decrypts a project's stored runtime env back to a plain object, or null. The
 *  caller must have selected `+runtimeEnvEnc`, which is off by default. */
export function decryptRuntimeEnv(project) {
  if (!project?.runtimeEnvEnc) return null;
  return JSON.parse(decryptSecret(project.runtimeEnvEnc));
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
  const cloning = Boolean(normalizedRepo && !root); // a repo with no local folder yet
  const project = await Project.create({
    userId, name,
    trusted: !cloning, // cloned code is untrusted; a folder or URL project is trusted
    ...(root ? { workspaceRoot: root } : {}),
    ...(url ? { targetUrl: url } : {}),
    ...(normalizedRepo ? { repoUrl: normalizedRepo } : {}),
    ...(cloning ? { cloneStatus: 'cloning' } : {}),
    ...runtimeEnvFields(runtimeEnv), // encrypted at rest; empty map sets nothing
    ...(startScript && startScript.trim() ? { startScript: startScript.trim() } : {}),
  });
  if (cloning && scheduleClone) {
    cloneQueue.enqueue(() => runCloneJob({ projectId: project._id, repoUrl: normalizedRepo, userId })
      .catch((err) => logger.error({ err: err.message }, 'clone job crashed')));
  }
  return project;
}

/**
 * Where an uploaded folder is written before it is scanned. A subdirectory per
 * upload, under the OS temp dir, so nothing lands in the repo or a user path.
 * Uploaded code is UNTRUSTED (exactly like a cloned repo): it is discovered and
 * statically scanned, never started, so writing it here can never execute it.
 */
const UPLOAD_ROOT = path.join(os.tmpdir(), 'agentiq-uploads');
const UPLOAD_MAX_FILES = 3000;
const UPLOAD_MAX_FILE_BYTES = 512 * 1024; // 512 KB: source files, not build output
const UPLOAD_MAX_TOTAL_BYTES = 12 * 1024 * 1024; // 12 MB of source across the folder
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // reap an upload workspace a day after it lands

/**
 * Best-effort reaping of old upload workspaces so the disk cannot fill on a small
 * VM. An assessment runs within minutes of upload, so a day-old workspace is
 * spent. Failures are swallowed: a full disk or a race must never fail an upload.
 */
async function sweepOldUploads() {
  try {
    const entries = await readdir(UPLOAD_ROOT, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(entries.map(async (e) => {
      if (!e.isDirectory()) return;
      const p = path.join(UPLOAD_ROOT, e.name);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > UPLOAD_TTL_MS) await rm(p, { recursive: true, force: true });
      } catch { /* a concurrent reap or a vanished dir: ignore */ }
    }));
  } catch { /* UPLOAD_ROOT not created yet: nothing to sweep */ }
}

/**
 * Registers a project from an uploaded folder: the browser (or the CLI) reads a
 * folder the user picked, and sends `files` as [{ path, content }] with the
 * project-relative path of each source file. This is the hosted-safe analogue of
 * pointing at a local folder: the server can't see the user's disk, so the files
 * come to it. Each path is contained under a fresh workspace dir (no absolute
 * paths, no `..` escape), size-capped, and the project is marked untrusted so the
 * pipeline scans it without ever running it.
 */
export async function createUploadedProject({ userId, name, files }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new DiscoveryError('No files were uploaded', 'EMPTY_UPLOAD', 400);
  }
  if (files.length > UPLOAD_MAX_FILES) {
    throw new DiscoveryError(
      `That folder has ${files.length} files, over the ${UPLOAD_MAX_FILES} limit. `
      + 'Remove build output (node_modules, dist) or scan a public GitHub repo instead.',
      'UPLOAD_TOO_MANY', 413,
    );
  }
  void sweepOldUploads(); // fire-and-forget: reap yesterday's uploads first
  const dir = path.join(UPLOAD_ROOT, `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`);
  await mkdir(dir, { recursive: true });

  let total = 0;
  let written = 0;
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    const rel = path.normalize(f.path);
    // Refuse anything that could write outside the fresh workspace dir.
    if (!rel || rel === '.' || path.isAbsolute(rel)
      || rel.split(/[\\/]/).includes('..') || rel.includes('\0')) {
      throw new DiscoveryError(`Unsafe file path in the upload: ${f.path}`, 'UPLOAD_BAD_PATH', 400);
    }
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > UPLOAD_MAX_FILE_BYTES) continue; // skip a single oversized file, keep the rest
    total += bytes;
    if (total > UPLOAD_MAX_TOTAL_BYTES) {
      throw new DiscoveryError(
        `The folder is over ${Math.round(UPLOAD_MAX_TOTAL_BYTES / (1024 * 1024))} MB of source. `
        + 'Scan a smaller folder or point at a public GitHub repo.',
        'UPLOAD_TOO_LARGE', 413,
      );
    }
    const dest = path.join(dir, rel);
    if (dest !== dir && !dest.startsWith(dir + path.sep)) {
      throw new DiscoveryError(`Unsafe file path in the upload: ${f.path}`, 'UPLOAD_BAD_PATH', 400);
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.content, 'utf8');
    written += 1;
  }
  if (written === 0) {
    throw new DiscoveryError('No usable source files were found in that folder', 'EMPTY_UPLOAD', 400);
  }

  return Project.create({
    userId,
    name: (typeof name === 'string' && name.trim()) ? name.trim() : 'Uploaded project',
    workspaceRoot: realpathSync(dir),
    trusted: false, // uploaded code is never started, only statically scanned
    cloneStatus: 'ready',
  });
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
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new DiscoveryError('Project not found', 'NOT_FOUND', 404);
  if (runtimeEnv !== undefined) {
    const { runtimeEnvEnc, runtimeEnvKeys } = runtimeEnvFields(runtimeEnv);
    project.runtimeEnvEnc = runtimeEnvEnc; // undefined clears it
    project.runtimeEnvKeys = runtimeEnvKeys;
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
  return {
    id: project._id, runtimeEnvKeys: project.runtimeEnvKeys ?? [],
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
  const project = await Project.findOne({ _id: projectId, userId });
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
  Object.assign(project, runtimeEnvFields(parsed)); // encrypt before it touches the DB
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
  // The encrypted env blob is select:false, so it is never even loaded here; the
  // stored key NAMES (not a secret) are all the list needs.
  const projects = await Project.find({ userId }).sort({ createdAt: -1 }).lean();
  return projects.map((p) => ({ ...p, runtimeEnvKeys: p.runtimeEnvKeys ?? [] }));
}

/** One project with its latest discovery, scoped to the owner. */
export async function getProject({ userId, projectId }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) return null;
  const latest = await Discovery.findOne({ projectId, userId }).sort({ createdAt: -1 }).lean();
  return { project: { ...project.toJSON(), runtimeEnvKeys: project.runtimeEnvKeys ?? [] }, discovery: latest };
}

export default {
  createProject, createUploadedProject, updateProjectEnv, discoverProject, listProjects, getProject,
};
