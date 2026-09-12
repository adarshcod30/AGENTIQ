/**
 * OpenAPI 3.1 specification for the fixtures.
 *
 * ONE builder produces BOTH specs, differing only in `servers` and `title`.
 * The apps serve an identical contract, so their specs must too: writing them
 * as two hand-maintained files would let them drift, and the grounding
 * ablation measures spec-grounded generation against exactly this document.
 *
 * Regenerate with:  node fixtures/shared/openapi.js
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PORTS } from './data.js';

const userSchema = {
  type: 'object',
  required: ['id', 'username', 'email', 'role'],
  properties: {
    id: { type: 'integer', examples: [1] },
    username: { type: 'string', examples: ['alice'] },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['user', 'admin'] },
  },
};

const itemSchema = {
  type: 'object',
  required: ['id', 'name', 'price', 'ownerId'],
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    price: { type: 'number', format: 'float' },
    ownerId: { type: 'integer' },
  },
};

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
};

const json = (schema) => ({ content: { 'application/json': { schema } } });

export function buildSpec(variant) {
  const port = PORTS[variant];
  return {
    openapi: '3.1.0',
    info: {
      title: `AGENTIQ fixture: ${variant}-api`,
      version: '1.0.0',
      description:
        variant === 'vulnerable'
          ? 'DELIBERATELY INSECURE evaluation fixture. Never deploy. Identical contract to hardened-api.'
          : 'Hardened evaluation fixture. Identical contract to vulnerable-api, every defect fixed.',
    },
    servers: [{ url: `http://127.0.0.1:${port}`, description: `${variant} fixture` }],
    components: {
      schemas: { User: userSchema, Item: itemSchema, Error: errorSchema },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Admin bearer token' },
      },
    },
    paths: {
      '/health': {
        get: {
          operationId: 'getHealth',
          summary: 'Liveness probe',
          responses: {
            200: {
              description: 'Service is up',
              ...json({
                type: 'object',
                required: ['status', 'variant'],
                properties: { status: { type: 'string' }, variant: { type: 'string' } },
              }),
            },
          },
        },
      },
      '/users/{id}': {
        get: {
          operationId: 'getUserById',
          summary: 'Fetch one user by id',
          parameters: [{
            name: 'id', in: 'path', required: true,
            schema: { type: 'integer', minimum: 1 },
            description: 'Numeric user id',
          }],
          responses: {
            200: { description: 'The user', ...json({ $ref: '#/components/schemas/User' }) },
            400: { description: 'Invalid id', ...json({ $ref: '#/components/schemas/Error' }) },
            404: { description: 'Not found', ...json({ $ref: '#/components/schemas/Error' }) },
          },
        },
      },
      '/items': {
        get: {
          operationId: 'listItems',
          summary: 'List items, optionally filtered by owner',
          parameters: [{
            name: 'ownerId', in: 'query', required: false,
            schema: { type: 'integer', minimum: 1 },
          }],
          responses: {
            200: {
              description: 'Items',
              ...json({ type: 'array', items: { $ref: '#/components/schemas/Item' } }),
            },
            400: { description: 'Invalid ownerId', ...json({ $ref: '#/components/schemas/Error' }) },
          },
        },
      },
      '/search': {
        get: {
          operationId: 'search',
          summary: 'Search page (returns HTML)',
          parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }],
          responses: {
            200: { description: 'HTML results page', content: { 'text/html': { schema: { type: 'string' } } } },
          },
        },
      },
      '/admin/users': {
        get: {
          operationId: 'listAllUsers',
          summary: 'Privileged: list every user',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'All users',
              ...json({
                type: 'object',
                required: ['users'],
                properties: { users: { type: 'array', items: { $ref: '#/components/schemas/User' } } },
              }),
            },
            401: { description: 'Unauthorized', ...json({ $ref: '#/components/schemas/Error' }) },
          },
        },
      },
      '/fetch': {
        get: {
          operationId: 'fetchUrlPreview',
          summary: 'Fetch a preview of the given URL',
          parameters: [{
            name: 'url', in: 'query', required: true,
            schema: { type: 'string', format: 'uri' },
            description: 'Absolute http(s) URL to preview',
          }],
          responses: {
            200: {
              description: 'Preview of the fetched URL',
              ...json({
                type: 'object',
                required: ['url', 'ok'],
                properties: {
                  url: { type: 'string' },
                  ok: { type: 'boolean' },
                  status: { type: 'integer' },
                  contentType: { type: 'string' },
                  title: { type: 'string' },
                },
              }),
            },
            400: { description: 'Invalid or disallowed url', ...json({ $ref: '#/components/schemas/Error' }) },
          },
        },
      },
      '/go': {
        get: {
          operationId: 'redirectNext',
          summary: 'Redirect the browser to the given destination',
          parameters: [{
            name: 'next', in: 'query', required: false,
            schema: { type: 'string' },
            description: 'Where to send the browser after the bounce',
          }],
          responses: {
            302: { description: 'Redirect to the destination' },
          },
        },
      },
      '/login': {
        post: {
          operationId: 'login',
          summary: 'Exchange credentials for a token',
          requestBody: {
            required: true,
            ...json({
              type: 'object',
              required: ['username', 'password'],
              properties: { username: { type: 'string' }, password: { type: 'string' } },
            }),
          },
          responses: {
            200: {
              description: 'Token issued',
              ...json({
                type: 'object',
                required: ['token', 'user'],
                properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/User' } },
              }),
            },
            401: { description: 'Invalid credentials', ...json({ $ref: '#/components/schemas/Error' }) },
          },
        },
      },
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(import.meta.dirname, '..');
  for (const variant of ['vulnerable', 'hardened']) {
    const out = path.join(root, `${variant}-api`, 'openapi.json');
    writeFileSync(out, `${JSON.stringify(buildSpec(variant), null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(root, out)}\n`);
  }
}
