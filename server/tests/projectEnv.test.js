/**
 * Importing the runtime env from a project's own .env file: the "access" toggle.
 * The file is read through the jail (so it must be inside the workspace), the
 * values are stored server-side, and only the key NAMES ever come back.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { createProject, importEnvFromFile } from '../src/services/discovery.service.js';

const app = createApp({ logging: false });
let userId;
let dir;

beforeAll(async () => { await connectTestDb(); await registerAllTools(); });
afterAll(async () => { await disconnectTestDb(); });

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Project.deleteMany({})]);
  await request(app).post('/api/auth/register').send({
    displayName: 'Dev', email: 'env@example.com', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  userId = (await User.findOne({ email: 'env@example.com' }))._id;
  dir = mkdtempSync(path.join(tmpdir(), 'env-proj-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('importEnvFromFile', () => {
  it('reads the project .env, stores it, and returns only key names', async () => {
    writeFileSync(path.join(dir, '.env'), '# a comment\nMONGO_URI=mongodb://localhost:27017/app\nJWT_SECRET="s3cr3t-value"\n');
    const project = await createProject({ userId, name: 'Local', workspaceRoot: dir });

    const result = await importEnvFromFile({ userId, projectId: project._id });
    expect(result.runtimeEnvKeys.sort()).toEqual(['JWT_SECRET', 'MONGO_URI']);
    expect(result.imported).toBe(2);

    // Values are stored server-side (quotes stripped) but only reachable with the select.
    const stored = await Project.findById(project._id).select('+runtimeEnv');
    expect(stored.runtimeEnv.get('JWT_SECRET')).toBe('s3cr3t-value');
    expect(stored.runtimeEnv.get('MONGO_URI')).toBe('mongodb://localhost:27017/app');
  });

  it('errors clearly when there is no .env file', async () => {
    const project = await createProject({ userId, name: 'Local', workspaceRoot: dir });
    await expect(importEnvFromFile({ userId, projectId: project._id })).rejects.toThrow(/No \.env file/i);
  });

  it('refuses a project that has no local folder', async () => {
    const project = await createProject({ userId, name: 'Url', targetUrl: 'https://example.com/' });
    await expect(importEnvFromFile({ userId, projectId: project._id })).rejects.toThrow(/no local folder/i);
  });

  it('refuses to read anything but a .env file', async () => {
    const project = await createProject({ userId, name: 'Local', workspaceRoot: dir });
    await expect(importEnvFromFile({ userId, projectId: project._id, file: 'package.json' }))
      .rejects.toThrow(/\.env/i);
  });
});
