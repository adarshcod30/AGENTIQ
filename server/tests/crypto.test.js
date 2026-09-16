/**
 * The secret-at-rest encryption: AES-256-GCM, a dedicated ENCRYPTION_KEY that is
 * independent of JWT_SECRET, and backward-compatible decryption of data written
 * before the dedicated key existed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { env } from '../src/config/env.js';
import { encryptSecret, decryptSecret, last4 } from '../src/services/crypto.service.js';

const originalEncKey = env.ENCRYPTION_KEY;
afterEach(() => { env.ENCRYPTION_KEY = originalEncKey; });

const flipFirst = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);

describe('crypto.service', () => {
  it('round-trips a secret in the v1 GCM envelope, ciphertext never the plaintext', () => {
    const token = encryptSecret('hunter2-secret-value');
    expect(token).toMatch(/^v1:/);
    expect(token).not.toContain('hunter2-secret-value');
    expect(decryptSecret(token)).toBe('hunter2-secret-value');
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const parts = encryptSecret('do-not-tamper').split(':');
    parts[2] = flipFirst(parts[2]); // corrupt the auth tag
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('keeps the encryption key independent of JWT_SECRET, and still reads legacy data', () => {
    // Written before any dedicated key: uses the JWT_SECRET-derived key.
    env.ENCRYPTION_KEY = undefined;
    const legacyToken = encryptSecret('legacy-value');

    // A dedicated key is now configured.
    env.ENCRYPTION_KEY = 'dedicated-encryption-key-abcdefghijklmnop-0001';
    // Old data still decrypts via the fallback.
    expect(decryptSecret(legacyToken)).toBe('legacy-value');
    // New data round-trips under the dedicated key.
    const freshToken = encryptSecret('fresh-value');
    expect(decryptSecret(freshToken)).toBe('fresh-value');

    // Proof the keys are genuinely independent: without the dedicated key
    // (JWT_SECRET alone), the fresh token must NOT decrypt.
    env.ENCRYPTION_KEY = undefined;
    expect(() => decryptSecret(freshToken)).toThrow();
  });

  it('last4 exposes only the tail', () => {
    expect(last4('abcdef1234')).toBe('1234');
    expect(last4('ab')).toBe('****');
  });
});
