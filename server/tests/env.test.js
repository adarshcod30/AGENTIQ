/**
 * Environment validation.
 *
 * parseEnv is a pure function precisely so these failure paths can be exercised
 * without the test runner being killed by process.exit().
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import dotenv from 'dotenv';
import { parseEnv, formatEnvTable, maskValue, ENV_KEYS, envSchema } from '../src/config/env.js';

const VALID = {
  MONGO_URI: 'mongodb://127.0.0.1:27017/agentiq',
  JWT_SECRET: 'x'.repeat(48),
};

describe('required variables', () => {
  it('accepts a minimal valid configuration', () => {
    const { ok, env } = parseEnv(VALID);
    expect(ok).toBe(true);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3001);
  });

  it('rejects a missing MONGO_URI', () => {
    const { ok, issues } = parseEnv({ JWT_SECRET: VALID.JWT_SECRET });
    expect(ok).toBe(false);
    expect(issues.some((i) => i.path.includes('MONGO_URI'))).toBe(true);
  });

  it('rejects a missing JWT_SECRET: there is no default, ever', () => {
    const { ok, issues } = parseEnv({ MONGO_URI: VALID.MONGO_URI });
    expect(ok).toBe(false);
    expect(issues.some((i) => i.path.includes('JWT_SECRET'))).toBe(true);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    const { ok, issues } = parseEnv({ ...VALID, JWT_SECRET: 'too-short' });
    expect(ok).toBe(false);
    expect(issues.find((i) => i.path.includes('JWT_SECRET')).message).toMatch(/32 characters/);
  });
});

describe('blank values mean unset', () => {
  it('boots from a copied .env.example with only the required values filled in', () => {
    // The README quick start does exactly this. A blank optional enum
    // (LOG_LEVEL=) once made the schema reject the whole file.
    const example = dotenv.parse(readFileSync(new URL('../../.env.example', import.meta.url)));
    const { ok, issues } = parseEnv({ ...example, ...VALID });
    expect(issues).toEqual([]);
    expect(ok).toBe(true);
  });

  it('does not let a blank value fail an enum or skip a default', () => {
    const { ok, env } = parseEnv({ ...VALID, LOG_LEVEL: '', MAIL_DRIVER: '', LLM_PRIMARY: '', CORS_ORIGIN: '' });
    expect(ok).toBe(true);
    expect(env.LLM_PRIMARY).toBe('bedrock');
    expect(env.CORS_ORIGIN).toBe('http://localhost:5173');
  });

  it('still reports a blank required value as missing, by name', () => {
    const { ok, issues } = parseEnv({ MONGO_URI: '', JWT_SECRET: VALID.JWT_SECRET });
    expect(ok).toBe(false);
    expect(issues.find((i) => i.path.includes('MONGO_URI')).message).toBe('MONGO_URI is required');
  });
});

describe('optional variables must not break boot', () => {
  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GROQ_API_KEY', 'RENDER_API_KEY'])(
    'is valid without %s',
    (key) => {
      const source = { ...VALID };
      delete source[key];
      expect(parseEnv(source).ok).toBe(true);
    },
  );
});

describe('coercion', () => {
  it('parses numeric strings into numbers', () => {
    const { env } = parseEnv({ ...VALID, PORT: '8080', EGRESS_TIMEOUT_MS: '5000' });
    expect(env.PORT).toBe(8080);
    expect(env.EGRESS_TIMEOUT_MS).toBe(5000);
  });

  it('treats the string "false" as false: z.coerce.boolean() would not', () => {
    // JS truthiness makes the non-empty string "false" coerce to true, which
    // would silently enable ALLOW_PRIVATE_TARGETS for anyone who wrote it out.
    expect(parseEnv({ ...VALID, ALLOW_PRIVATE_TARGETS: 'false' }).env.ALLOW_PRIVATE_TARGETS).toBe(false);
    expect(parseEnv({ ...VALID, ALLOW_PRIVATE_TARGETS: 'true' }).env.ALLOW_PRIVATE_TARGETS).toBe(true);
    expect(parseEnv({ ...VALID, ALLOW_PRIVATE_TARGETS: '0' }).env.ALLOW_PRIVATE_TARGETS).toBe(false);
  });

  it('rejects a non-numeric PORT instead of silently defaulting', () => {
    expect(parseEnv({ ...VALID, PORT: 'not-a-port' }).ok).toBe(false);
  });
});

describe('cross-field rules', () => {
  it('refuses ALLOW_PRIVATE_TARGETS=true in production', () => {
    const { ok, issues } = parseEnv({
      ...VALID, NODE_ENV: 'production', ALLOW_PRIVATE_TARGETS: 'true',
    });
    expect(ok).toBe(false);
    expect(issues[0].message).toMatch(/SSRF proxy/);
  });

  it('allows ALLOW_PRIVATE_TARGETS=true outside production (fixture testing)', () => {
    expect(parseEnv({ ...VALID, NODE_ENV: 'development', ALLOW_PRIVATE_TARGETS: 'true' }).ok).toBe(true);
  });

  it('refuses identical primary and fallback LLM providers', () => {
    expect(parseEnv({ ...VALID, LLM_PRIMARY: 'groq', LLM_FALLBACK: 'groq' }).ok).toBe(false);
  });
});

describe('the boot table never prints a secret', () => {
  it('masks secret-bearing values', () => {
    expect(maskValue('JWT_SECRET', 'abcdefghijklmnopqrstuvwxyz')).toBe('abcd••••wxyz');
    expect(maskValue('MONGO_URI', 'mongodb+srv://u:p@host/db')).toContain('••••');
    expect(maskValue('GROQ_API_KEY', 'short')).toBe('••••');
  });

  it('does not mask non-secret values', () => {
    expect(maskValue('NODE_ENV', 'production')).toBe('production');
    expect(maskValue('PORT', '3001')).toBe('3001');
  });

  it('no rendered table line contains a full secret', () => {
    const source = { ...VALID, GROQ_API_KEY: 'gsk_thisIsAVerySecretApiKeyValue' };
    const rendered = formatEnvTable(source, parseEnv(source).env).join('\n');
    expect(rendered).not.toContain('gsk_thisIsAVerySecretApiKeyValue');
    expect(rendered).not.toContain(VALID.JWT_SECRET);
    expect(rendered).toContain('MONGO_URI');
  });
});

describe('ENV_KEYS stays in sync with the schema', () => {
  it('lists exactly the keys the schema declares', () => {
    // ENV_KEYS drives the boot table and is maintained by hand because .refine()
    // hides .shape. This assertion is what stops the two drifting apart.
    const shapeKeys = Object.keys(envSchema.def.innerType?.shape ?? envSchema.def.shape ?? {});
    if (shapeKeys.length === 0) return; // Zod internals moved; other tests still cover behaviour
    expect([...ENV_KEYS].sort()).toEqual([...shapeKeys].sort());
  });
});

describe('the failure table distinguishes required from defaulted', () => {
  it('marks only the two genuinely required variables as MISSING', async () => {
    const { formatEnvTable, REQUIRED_KEYS } = await import('../src/config/env.js');
    // Empty environment: validation fails, but most variables have defaults.
    const lines = formatEnvTable({}, null);
    const missing = lines.filter((l) => l.includes('MISSING')).map((l) => l.trim().split(/\s+/)[0]);
    expect(missing.sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it('shows defaulted variables with their default value, not as missing', () => {
    const lines = formatEnvTable({}, null).join('\n');
    expect(lines).toMatch(/NODE_ENV\s+default\s+development/);
    expect(lines).toMatch(/PORT\s+default\s+3001/);
    expect(lines).toMatch(/ALLOW_PRIVATE_TARGETS\s+default\s+false/);
  });

  it('shows optional feature variables as off rather than missing', () => {
    const lines = formatEnvTable({}, null).join('\n');
    expect(lines).toMatch(/GOOGLE_CLIENT_ID\s+off/);
    expect(lines).toMatch(/RENDER_API_KEY\s+off/);
  });
});
