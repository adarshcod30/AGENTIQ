/**
 * The self-host configuration surface (Phase 7, BYOK).
 *
 * The one property that matters most here: it reports presence, never values.
 * These tests prove a configured capability reads as configured, an unconfigured
 * one does not, "any" and "all" modes are honoured, and nothing in the output
 * carries a secret value.
 */
import { describe, it, expect } from 'vitest';
import { buildConfigSurface } from '../src/services/settings.service.js';

describe('buildConfigSurface', () => {
  it('marks a capability configured only when its keys are present', () => {
    const surface = buildConfigSurface({ GROQ_API_KEY: 'gsk_secret_value' });
    const groq = surface.capabilities.find((c) => c.name === 'Groq LLM provider');
    expect(groq.configured).toBe(true);
    expect(groq.keys[0].present).toBe(true);

    const bedrock = surface.capabilities.find((c) => c.name === 'Bedrock LLM provider');
    expect(bedrock.configured).toBe(false);
    expect(bedrock.keys[0].present).toBe(false);
  });

  it('honours "any" mode: one of several keys is enough', () => {
    const surface = buildConfigSurface({ GMAIL_APP_PASSWORD: 'app-pass' });
    const mail = surface.capabilities.find((c) => c.name === 'Verification email');
    expect(mail.mode).toBe('any');
    expect(mail.configured).toBe(true);
  });

  it('honours "all" mode: every key is required', () => {
    const surface = buildConfigSurface({ GOOGLE_CLIENT_ID: 'id-only' });
    const oauth = surface.capabilities.find((c) => c.name === 'Google OAuth sign-in');
    expect(oauth.mode).toBe('all');
    expect(oauth.configured).toBe(false);
  });

  it('lists deployment providers with their credential name and status', () => {
    const surface = buildConfigSurface({ RENDER_API_KEY: 'rnd_secret' });
    const render = surface.deployProviders.find((p) => p.name === 'render');
    expect(render.configured).toBe(true);
    expect(render.key).toBe('RENDER_API_KEY');
    const railway = surface.deployProviders.find((p) => p.name === 'railway');
    expect(railway.configured).toBe(false);
  });

  it('never leaks a value: the serialised surface contains no secret', () => {
    const secret = 'gsk_this_should_never_appear';
    const surface = buildConfigSurface({ GROQ_API_KEY: secret, RENDER_API_KEY: 'rnd_also_secret' });
    expect(JSON.stringify(surface)).not.toContain(secret);
    expect(JSON.stringify(surface)).not.toContain('rnd_also_secret');
    // Guidance is present so a self-hoster knows what to do.
    const groq = surface.capabilities.find((c) => c.name === 'Groq LLM provider');
    expect(groq.keys[0].guidance).toMatch(/console\.groq\.com/);
  });
});
