/**
 * Google OAuth strategy, registered LAZILY.
 *
 * passport-google-oauth20 throws `TypeError: OAuth2Strategy requires a
 * clientID option` when clientID is undefined. Registering the strategy at
 * module top level would therefore kill a fresh clone with no Google
 * credentials before it even binds a port.
 *
 * The strategy is registered only when BOTH credentials are present.
 * Without them the server boots fully and Google routes return a clear 503;
 * every other feature works.
 */
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const GOOGLE_STRATEGY = 'google';

/** True when Google sign-in is configured. Checked by routes and /api/health. */
export function isGoogleOAuthConfigured() {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

/**
 * Registers the strategy if configured. Idempotent and safe to call at boot.
 * Returns true if the strategy is now available.
 */
export function configurePassport() {
  if (!isGoogleOAuthConfigured()) {
    logger.warn(
      'Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET absent): ' +
        'sign-in with Google is disabled. Every other feature is unaffected.',
    );
    return false;
  }

  if (passport._strategy?.(GOOGLE_STRATEGY)) return true; // already registered

  passport.use(
    GOOGLE_STRATEGY,
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // From config, never hardcoded: a localhost callback URL would make the
        // app impossible to deploy.
        callbackURL: `${env.API_BASE_URL}/api/auth/google/callback`,
        scope: ['profile', 'email'],
      },
      // We mint our own JWT immediately, so there is no session to populate and
      // no need for express-session at all.
      (_accessToken, _refreshToken, profile, done) => done(null, profile),
    ),
  );

  logger.info('Google OAuth strategy registered');
  return true;
}

export { passport };
export default configurePassport;
