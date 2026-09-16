/**
 * Symmetric encryption for every secret the platform stores and later reuses:
 * per-user API tokens for GitHub, Render and Vercel, BYOK AI provider keys, and
 * pasted runtime env. They are encrypted at rest so a database dump never hands
 * over anyone's accounts.
 *
 * AES-256-GCM with a random 12-byte IV per value and the GCM auth tag, so a
 * tampered ciphertext fails to decrypt rather than returning garbage.
 *
 * The key derives (scrypt, fixed versioned salt) from a DEDICATED `ENCRYPTION_KEY`
 * when set, so the encryption key is independent of `JWT_SECRET`: a leak of the
 * auth-signing secret does not expose stored secrets, and vice versa. When
 * `ENCRYPTION_KEY` is absent the key falls back to `JWT_SECRET`, so a deployment
 * without the dedicated key still works. Decryption also tries the JWT_SECRET-
 * derived key as a fallback, so data written before a dedicated key was introduced
 * still decrypts, and a one-off re-save migrates it onto the new key.
 */
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';

const SALT = 'agentiq-cred-v1';
let cache = null; // recomputed only when the key material actually changes

/**
 * The active key plus any legacy key to try on decrypt. scrypt is not free, so
 * the derived keys are cached and only rebuilt if the underlying env values
 * change (which they do not in production, but can between tests).
 */
function keys() {
  const primaryMaterial = String(env.ENCRYPTION_KEY || env.JWT_SECRET || '');
  const jwtMaterial = String(env.JWT_SECRET || '');
  if (!cache || cache.primaryMaterial !== primaryMaterial || cache.jwtMaterial !== jwtMaterial) {
    const usingDedicated = Boolean(env.ENCRYPTION_KEY) && env.ENCRYPTION_KEY !== env.JWT_SECRET;
    cache = {
      primaryMaterial,
      jwtMaterial,
      primary: scryptSync(primaryMaterial, SALT, 32),
      // Only distinct from primary when a dedicated key is in use; then it decrypts
      // anything written under the old JWT_SECRET-derived key.
      legacy: usingDedicated ? scryptSync(jwtMaterial, SALT, 32) : null,
    };
  }
  return cache;
}

/** Encrypts a UTF-8 string into a compact "v1:iv:tag:ciphertext" base64url token. */
export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys().primary, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/** Decrypts a token from encryptSecret. Throws if malformed or tampered. */
export function decryptSecret(token) {
  const [v, ivB, tagB, ctB] = String(token).split(':');
  if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('Malformed encrypted secret');
  const iv = Buffer.from(ivB, 'base64url');
  const tag = Buffer.from(tagB, 'base64url');
  const ct = Buffer.from(ctB, 'base64url');
  const withKey = (k) => {
    const decipher = createDecipheriv('aes-256-gcm', k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  };
  const { primary, legacy } = keys();
  try {
    return withKey(primary);
  } catch (err) {
    if (legacy) {
      try { return withKey(legacy); } catch { /* neither key: report the primary failure */ }
    }
    throw err;
  }
}

/** Last 4 characters, for a "…ab12" hint in the UI. Never the whole token. */
export function last4(token) {
  const s = String(token);
  return s.length <= 4 ? '****' : s.slice(-4);
}

export default { encryptSecret, decryptSecret, last4 };
