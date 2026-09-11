/**
 * Boot without optional configuration, and the health endpoint.
 *
 * passport-google-oauth20 throws
 *   TypeError: OAuth2Strategy requires a clientID option
 * when the strategy is registered without GOOGLE_CLIENT_ID, which would kill a
 * fresh clone before it binds a port. tests/setup.js deletes both Google
 * variables, so every assertion here runs against an unconfigured server.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { isGoogleOAuthConfigured } from '../src/config/passport.js';

const app = createApp({ logging: false });

describe('boot without optional configuration', () => {
  it('Google OAuth is genuinely unconfigured in this test run', () => {
    expect(process.env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(isGoogleOAuthConfigured()).toBe(false);
  });

  it('builds the app without throwing when Google credentials are absent', () => {
    expect(() => createApp({ logging: false })).not.toThrow();
  });

  it('serves requests rather than dying at import time', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('refuses Google sign-in with an explanatory 503, not a crash or a 404', async () => {
    const res = await request(app).get('/api/auth/google');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('OAUTH_NOT_CONFIGURED');
  });
});

describe('GET /api/health', () => {
  it('returns 200 with the documented shape', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { data } = res.body;
    expect(data).toHaveProperty('status');
    expect(data).toHaveProperty('uptime');
    expect(data).toHaveProperty('mongo');
    expect(Array.isArray(data.llmProviders)).toBe(true);
  });

  it('reports providers as unconfigured when no key is set, never as a static badge', async () => {
    const { body } = await request(app).get('/api/health');
    const names = body.data.llmProviders.map((p) => p.name).sort();
    expect(names).toEqual(['bedrock', 'groq']);
    // Nothing here is a hardcoded chip: every flag is derived from real state.
    expect(body.data.llmProviders.every((p) => p.configured === false)).toBe(true);
    expect(body.data.googleOAuth).toBe('disabled');
  });

  it('reports mongo as disconnected rather than pretending to be healthy', async () => {
    const { body } = await request(app).get('/api/health');
    expect(body.data.mongo).toBe('disconnected');
    expect(body.data.status).toBe('degraded');
  });

  /**
   * The chain as it will ACTUALLY resolve, not as configured.
   *
   * providerOrder() silently drops a provider whose credentials or model id are
   * missing, so LLM_PRIMARY=bedrock does not mean bedrock is answering. That
   * gap ran a whole evaluation phase on the wrong provider. With nothing
   * configured, the default test posture, the chain must be EMPTY and say so,
   * rather than naming a provider that cannot serve a request.
   */
  it('reports the resolved chain, which is empty when nothing is configured', async () => {
    const { body } = await request(app).get('/api/health');
    expect(body.data.llmChain.order).toEqual([]);
    expect(body.data.llmChain.hasFallback).toBe(false);
    expect(body.data.llmChain.models).toHaveProperty('generation');
    expect(body.data.llmChain.models).toHaveProperty('explanation');
  });

  it('names the model each task would use once a provider is configured', async () => {
    env.GROQ_API_KEY = 'test-key-not-real';
    try {
      const { body } = await request(app).get('/api/health');
      expect(body.data.llmChain.order).toContain('groq');
      // The two tasks route independently: that is the point of the table.
      expect(body.data.llmChain.models.generation.groq).toBe('openai/gpt-oss-120b');
      expect(body.data.llmChain.models.explanation.groq).toBe('openai/gpt-oss-20b');
    } finally {
      delete env.GROQ_API_KEY;
    }
  });
});

describe('response envelope and security headers', () => {
  it('unknown routes return the { success:false, error } envelope', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: expect.stringContaining('/api/does-not-exist') },
    });
  });

  it('helmet security headers are present', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers).toHaveProperty('x-content-type-options', 'nosniff');
    expect(res.headers).toHaveProperty('x-frame-options');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('malformed JSON produces a typed error, not a stack trace', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
});
