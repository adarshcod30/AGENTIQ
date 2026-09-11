/**
 * Discovery, end to end over HTTP.
 *
 * The Phase 1 acceptance criterion (docs/10_AUTONOMOUS_PLATFORM.md §H): pointing
 * discovery at a project returns its real routes, with methods and path params,
 * and WITHOUT an LLM call. There is no LLM stub in this suite: if discovery tried
 * to reach a model it would fail, so a green run is itself the proof that the
 * surface was found deterministically.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { Discovery } from '../src/models/Discovery.js';

const app = createApp({ logging: false });
const VULN = path.resolve(import.meta.dirname, '../../fixtures/vulnerable-api');

let token;

async function authFor(email) {
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Dev', email, password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  return res.body.data.token;
}

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
});

afterAll(async () => { await disconnectTestDb(); });

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Project.deleteMany({}), Discovery.deleteMany({})]);
  token = await authFor('discovery@example.com');
});

describe('POST /api/projects', () => {
  it('registers a project and stores the canonical workspace root', async () => {
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Vulnerable fixture', workspaceRoot: VULN });
    expect(res.status).toBe(201);
    expect(res.body.data.project.name).toBe('Vulnerable fixture');
    expect(res.body.data.project.workspaceRoot).toContain('vulnerable-api');
  });

  it('refuses a workspace that does not exist', async () => {
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nope', workspaceRoot: '/does/not/exist/anywhere' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_WORKSPACE');
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/projects').send({ name: 'x', workspaceRoot: VULN });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/projects/:id/discover', () => {
  async function registerVuln() {
    const res = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Vulnerable fixture', workspaceRoot: VULN });
    return res.body.data.project.id;
  }

  it('discovers the real API surface with no LLM call', async () => {
    const id = await registerVuln();
    const res = await request(app).post(`/api/projects/${id}/discover`)
      .set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);

    const { discovery } = res.body.data;
    expect(discovery.framework).toBe('express');

    const surface = discovery.endpoints.map((e) => `${e.method} ${e.path}`).sort();
    expect(surface).toEqual([
      'GET /admin/users',
      'GET /health',
      'GET /items',
      'GET /search',
      'GET /users/:id',
      'POST /login',
    ]);

    const byId = discovery.endpoints.find((e) => e.path === '/users/:id');
    expect(byId.params).toEqual(['id']);
    expect(byId.file).toContain('server.js');
  });

  it('reads dependencies and scripts from package.json', async () => {
    // The fixtures root carries the package.json (the api subfolders do not),
    // so this proves the framework and dependency detection reads the manifest.
    const fixturesRoot = path.resolve(import.meta.dirname, '../../fixtures');
    const created = await request(app).post('/api/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Fixtures root', workspaceRoot: fixturesRoot });
    const res = await request(app).post(`/api/projects/${created.body.data.project.id}/discover`)
      .set('Authorization', `Bearer ${token}`).send({});
    const { discovery } = res.body.data;
    expect(discovery.framework).toBe('express');
    expect(discovery.frameworkSignals.some((s) => s.startsWith('dependency: express'))).toBe(true);
    expect(discovery.dependencies.map((d) => d.name)).toContain('express');
  });

  it('stamps lastDiscoveryAt on the project', async () => {
    const id = await registerVuln();
    await request(app).post(`/api/projects/${id}/discover`)
      .set('Authorization', `Bearer ${token}`).send({});
    const res = await request(app).get(`/api/projects/${id}`).set('Authorization', `Bearer ${token}`);
    expect(res.body.data.project.lastDiscoveryAt).not.toBeNull();
    expect(res.body.data.discovery).not.toBeNull();
  });

  it('will not discover another user project (no IDOR)', async () => {
    const id = await registerVuln();
    const otherToken = await authFor('intruder@example.com');
    const res = await request(app).post(`/api/projects/${id}/discover`)
      .set('Authorization', `Bearer ${otherToken}`).send({});
    expect(res.status).toBe(404);
  });
});
