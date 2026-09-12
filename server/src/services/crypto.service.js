/**
 * Symmetric encryption for secrets the platform must store and later reuse:
 * the per-user API tokens for GitHub, Render and Vercel. They are encrypted at
 * rest so a database dump never hands over anyone's cloud accounts.
 *
 * AES-256-GCM with a random 12-byte IV per value and the GCM auth tag, so a
 * tampered ciphertext fails to decrypt rather than returning garbage. The key is
 * derived from JWT_SECRET (already required, already the app's root secret) via
 * scrypt with a fixed, versioned salt: no new configuration, and rotating
 * JWT_SECRET rotates this too (old tokens then fail to decrypt and are simply
 * re-entered).
 */
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { env } from '../config/env.js';

const SALT = 'agentiq-cred-v1';
let cachedKey = null;

function key() {
  if (!cachedKey) cachedKey = scryptSync(String(env.JWT_SECRET ?? ''), SALT, 32);
  return cachedKey;
}

/** Encrypts a UTF-8 string into a compact "v1:iv:tag:ciphertext" base64url token. */
export function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

/** Decrypts a token from encryptSecret. Throws if malformed or tampered. */
export function decryptSecret(token) {
  const [v, ivB, tagB, ctB] = String(token).split(':');
  if (v !== 'v1' || !ivB || !tagB || !ctB) throw new Error('Malformed encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
}

/** Last 4 characters, for a "…ab12" hint in the UI. Never the whole token. */
export function last4(token) {
  const s = String(token);
  return s.length <= 4 ? '****' : s.slice(-4);
}

export default { encryptSecret, decryptSecret, last4 };
