/**
 * BYOK provider registry and the credential model's secret-hiding.
 *
 * These cover the parts that need no network: the field spec every provider
 * declares, the secret/config partition the store relies on, and the guarantee
 * that a credential never serialises its secret. The live call path is proven
 * by the end-to-end run, not here.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_PROVIDERS, AI_PROVIDER_NAMES, secretKeys, configKeys,
} from '../src/services/ai-providers.js';
import { AiProviderCredential } from '../src/models/AiProviderCredential.js';

describe('AI provider registry', () => {
  it('declares all six providers the product supports', () => {
    expect(AI_PROVIDER_NAMES.sort()).toEqual(
      ['anthropic', 'bedrock', 'gemini', 'groq', 'openai', 'xai'],
    );
  });

  it('every provider has at least one required secret field and a model field', () => {
    for (const name of AI_PROVIDER_NAMES) {
      const secrets = secretKeys(name);
      expect(secrets.length, `${name} has a secret`).toBeGreaterThan(0);
      const keys = AI_PROVIDERS[name].fields.map((f) => f.key);
      expect(keys, `${name} takes a model`).toContain('model');
    }
  });

  it('splits secret fields from config fields', () => {
    expect(secretKeys('bedrock').sort()).toEqual(['accessKeyId', 'secretAccessKey']);
    expect(configKeys('bedrock').sort()).toEqual(['model', 'region']);
    expect(secretKeys('openai')).toEqual(['apiKey']);
    expect(configKeys('openai')).toEqual(['model']);
  });
});

describe('AiProviderCredential.toJSON', () => {
  it('never serialises the encrypted secret', () => {
    const doc = new AiProviderCredential({
      userId: '000000000000000000000000',
      provider: 'openai',
      secret: 'v1:should-never-appear',
      config: new Map([['model', 'gpt-4o-mini']]),
      hints: new Map([['apiKey', 'ab12']]),
      verified: true,
      active: true,
    });
    const json = doc.toJSON();
    expect(JSON.stringify(json)).not.toContain('should-never-appear');
    expect(json).not.toHaveProperty('secret');
    expect(json).toMatchObject({
      provider: 'openai', connected: true, verified: true, active: true,
      config: { model: 'gpt-4o-mini' }, hints: { apiKey: 'ab12' },
    });
  });
});
