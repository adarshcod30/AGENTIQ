/**
 * AST route extraction.
 *
 * The two properties that matter, both found by a proof-of-concept over the
 * fixtures: the extractor finds real routes with their params, and it does NOT
 * mistake Express's `req.get(header)` for a `router.get(path)` route.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeSource, joinPath, pathParams } from '../src/mcp/analysis/routes.js';

const fixture = (name) => readFileSync(
  path.resolve(import.meta.dirname, '../../fixtures', name), 'utf8',
);

describe('pathParams', () => {
  it('extracts every :param', () => {
    expect(pathParams('/users/:id/posts/:postId')).toEqual(['id', 'postId']);
    expect(pathParams('/items')).toEqual([]);
  });
});

describe('joinPath', () => {
  it.each([
    ['/api', '/users', '/api/users'],
    ['/api/', '/users', '/api/users'],
    ['/api', '/', '/api'],
    ['', '/users', '/users'],
    ['/api', 'users', '/api/users'],
  ])('joins %s + %s = %s', (a, b, want) => {
    expect(joinPath(a, b)).toBe(want);
  });
});

describe('analyzeSource against the vulnerable fixture', () => {
  const { routes, parseError } = analyzeSource(fixture('vulnerable-api/server.js'), {
    filename: 'server.js',
  });

  it('parses without error', () => {
    expect(parseError).toBeNull();
  });

  it('finds the real routes with their methods', () => {
    const surface = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(surface).toEqual([
      'GET /admin/users',
      'GET /health',
      'GET /items',
      'GET /search',
      'GET /users/:id',
      'POST /login',
    ]);
  });

  it('captures path params', () => {
    const byId = routes.find((r) => r.path === '/users/:id');
    expect(byId.params).toEqual(['id']);
  });

  it('does NOT mistake req.get(header) for a route (the POC false positive)', () => {
    // The proof-of-concept matched req.get('origin') and req.get('authorization').
    const bogus = routes.filter((r) => r.path === 'origin' || r.path === 'authorization');
    expect(bogus).toEqual([]);
  });
});

describe('analyzeSource against the hardened fixture', () => {
  it('finds the same surface, still no header-getter false positives', () => {
    const { routes } = analyzeSource(fixture('hardened-api/server.js'), { filename: 'server.js' });
    const surface = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(surface).toEqual([
      'GET /admin/users',
      'GET /health',
      'GET /items',
      'GET /search',
      'GET /users/:id',
      'POST /login',
    ]);
  });
});

describe('mount detection', () => {
  it('records app.use(prefix, router) mounts and the router binding', () => {
    const code = `
      import express from 'express';
      const app = express();
      const users = express.Router();
      users.get('/:id', (req, res) => res.json({}));
      users.post('/', (req, res) => res.json({}));
      app.use('/api/users', users);
    `;
    const { routes, mounts, routers } = analyzeSource(code, { filename: 'app.js' });
    expect(routers).toContain('users');
    expect(routers).toContain('app');
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /:id', 'POST /']);
    expect(mounts).toEqual([
      expect.objectContaining({ prefix: '/api/users', targets: [{ var: 'users', import: null }] }),
    ]);
    // Composed, the surface is /api/users/:id and /api/users
    expect(joinPath('/api/users', '/:id')).toBe('/api/users/:id');
  });

  it('sees a router mounted behind middleware (app.use(prefix, mw, router))', () => {
    const code = `
      import express from 'express';
      const app = express();
      const auth = express.Router();
      auth.post('/login', (req, res) => res.json({}));
      app.use('/api/auth', rateLimit, auth);
    `;
    const { mounts } = analyzeSource(code, { filename: 'app.js' });
    expect(mounts[0].targets).toEqual([{ var: 'rateLimit', import: null }, { var: 'auth', import: null }]);
  });

  it('resolves an imported router mount target to its module', () => {
    const code = `
      const express = require('express');
      const app = express();
      const runs = require('./routes/runs.routes.js');
      app.use('/api/runs', runs);
    `;
    const { mounts, imports } = analyzeSource(code, { filename: 'app.js' });
    expect(mounts[0]).toEqual(
      expect.objectContaining({ prefix: '/api/runs', targets: [{ var: 'runs', import: null }] }),
    );
    expect(imports.runs).toBe('./routes/runs.routes.js');
  });
});
