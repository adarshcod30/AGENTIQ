/**
 * JWT issuing and verification.
 *
 * docs/02_TRD.md §8: HS256, 7-day expiry, payload { sub, email }.
 *
 * One expiry, defined once. `sub` carries the user id, so a token is tied to a
 * specific user document rather than only to an email address.
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const TOKEN_TTL = '7d';
export const TOKEN_ALG = 'HS256';

function secret() {
  // Defensive: index.js fails at boot without JWT_SECRET, but a direct import
  // in a mis-configured test should also fail loudly rather than sign with
  // `undefined`, which jsonwebtoken would reject with a confusing message.
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set: refusing to sign or verify tokens');
  }
  return env.JWT_SECRET;
}

export function generateToken(user) {
  return jwt.sign(
    { sub: String(user._id ?? user.id), email: user.email },
    secret(),
    { expiresIn: TOKEN_TTL, algorithm: TOKEN_ALG },
  );
}

export function verifyToken(token) {
  // Pinning algorithms prevents the "alg: none" and RS/HS confusion classes.
  return jwt.verify(token, secret(), { algorithms: [TOKEN_ALG] });
}

/** Cookie options used for both setting and clearing, so they always match. */
export function cookieOptions() {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}
