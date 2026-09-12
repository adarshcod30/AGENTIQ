/**
 * GitHub background cloning: a repo project is created immediately in a 'cloning'
 * state and the clone runs in a worker, so the create request never blocks on the
 * network. The clone function is injected here, so both the success and failure
 * paths are exercised deterministically without touching GitHub.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { Assessment } from '../src/models/Assessment.js';
import { createProject, runCloneJob } from '../src/services/discovery.service.js';
import { createAssessment } from '../src/services/assessment.service.js';
import { GitError } from '../src/services/git.service.js';

const app = createApp({ logging: false });
const VULN = path.resolve(import.meta.dirname, '../../fixtures/vulnerable-api');
const REPO = 'https://github.com/octocat/Hello-World';
let userId;

beforeAll(async () => { await connectTestDb(); await registerAllTools(); });
afterAll(async () => { await disconnectTestDb(); });

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Project.deleteMany({}), Assessment.deleteMany({})]);
  await request(app).post('/api/auth/register').send({
    displayName: 'Dev', email: 'clone@example.com', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  userId = (await User.findOne({ email: 'clone@example.com' }))._id;
});

describe('GitHub background clone', () => {
  it('creates the project in the cloning state, without blocking on the network', async () => {
    const project = await createProject({ userId, name: 'Repo', repoUrl: REPO, scheduleClone: false });
    expect(project.cloneStatus).toBe('cloning');
    expect(project.workspaceRoot).toBeFalsy(); // no workspace yet
    expect(project.repoUrl).toBe(REPO);
    expect(project.trusted).toBe(false); // cloned code is untrusted
  });

  it('flips to ready with a workspace when the clone job succeeds', async () => {
    const project = await createProject({ userId, name: 'Repo', repoUrl: REPO, scheduleClone: false });
    await runCloneJob({ projectId: project._id, repoUrl: REPO, clone: async () => ({ path: VULN, repoUrl: REPO }) });
    const done = await Project.findById(project._id);
    expect(done.cloneStatus).toBe('ready');
    expect(done.workspaceRoot).toBe(VULN);
  });

  it('flips to failed with the reason when the clone job errors', async () => {
    const project = await createProject({ userId, name: 'Repo', repoUrl: REPO, scheduleClone: false });
    await runCloneJob({
      projectId: project._id, repoUrl: REPO,
      clone: async () => { throw new GitError('Repository not found or not public.', 'REPO_NOT_ACCESSIBLE'); },
    });
    const done = await Project.findById(project._id);
    expect(done.cloneStatus).toBe('failed');
    expect(done.cloneError).toMatch(/not public/i);
    expect(done.workspaceRoot).toBeFalsy();
  });

  it('rejects a bad GitHub URL immediately, before any project is created', async () => {
    await expect(createProject({ userId, name: 'X', repoUrl: 'https://evil.com/x/y', scheduleClone: false }))
      .rejects.toThrow(/GitHub/i);
    expect(await Project.countDocuments({})).toBe(0);
  });

  it('refuses to assess a project that is still cloning', async () => {
    const project = await createProject({ userId, name: 'Repo', repoUrl: REPO, scheduleClone: false });
    await expect(createAssessment({ userId, projectId: project._id, schedule: false }))
      .rejects.toThrow(/still being cloned/i);
  });
});
