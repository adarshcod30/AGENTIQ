/**
 * Email verification.
 *
 * ── DESIGN DECISIONS ────────────────────────────────────────────────────────
 *
 * 1. TOKENS ARE HASHED AT REST. See models/EmailVerification.js. The plaintext
 *    exists only in the email.
 *
 * 2. ISSUING A NEW TOKEN INVALIDATES THE OLD ONES. Otherwise every "resend"
 *    click widens the window of live credentials for that address.
 *
 * 3. RESEND NEVER REVEALS WHETHER AN ACCOUNT EXISTS. It returns the same shape
 *    for a registered address, an unregistered one, and one already verified.
 *    /api/auth/login is already careful about this; an endpoint that leaks the
 *    same fact through a different door would make that care pointless.
 *
 * 4. THE TOKEN IS RETURNED TO THE CALLER ONLY WHEN IT WAS NOT ACTUALLY
 *    DELIVERED, AND NEVER IN PRODUCTION.
 *
 *    The condition is DELIVERY, not configuration. "Is a provider configured?"
 *    is a different question: Resend's free tier refuses any recipient except
 *    the account owner, so a perfectly configured server can still fail to
 *    deliver, leaving the user with no email and no link. Keying on what
 *    actually happened gives a developer a way forward after a failed send,
 *    while production reveals nothing regardless.
 *
 * 5. VERIFICATION IS SOFT. An unverified user can sign in and use the product;
 *    the UI shows a banner. Being locked out by a spam filter is worse than
 *    verification being advisory, and nothing here claims an enforcement that
 *    is not there.
 */
import { EmailVerification, TOKEN_TTL_MS, generateToken, hashToken } from '../models/EmailVerification.js';
import { User } from '../models/User.js';
import { sendMail, verificationEmail, isMailConfigured, resolveDriver } from './mailer.service.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export const VERIFY_RESULT = {
  VERIFIED: 'verified',
  ALREADY_VERIFIED: 'already_verified',
  INVALID: 'invalid',
  EXPIRED: 'expired',
};

/** Where the emailed link points: the app, which then calls the API. */
export function verificationUrl(token) {
  const url = new URL('/verify', env.APP_BASE_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * True only when it is safe to hand the raw token back through the API.
 *
 * Guarded by BOTH conditions on purpose. Either alone is one config mistake
 * away from an account-takeover primitive.
 */
export const mayRevealToken = ({ delivered = false } = {}) =>
  env.NODE_ENV !== 'production' && !delivered;

/**
 * Issues a fresh token and emails it. Existing unused tokens for the user are
 * invalidated first.
 *
 * @returns {{ sent, driver, url, token, revealed }}
 */
export async function issueVerification(user) {
  await EmailVerification.deleteMany({ userId: user._id, usedAt: null });

  const token = generateToken();
  await EmailVerification.create({
    userId: user._id,
    email: user.email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  const url = verificationUrl(token);
  const message = verificationEmail({
    displayName: user.displayName,
    url,
    ttlHours: Math.round(TOKEN_TTL_MS / 3_600_000),
  });

  const { sent, driver, error } = await sendMail({ to: user.email, ...message });
  if (error) logger.warn({ userId: String(user._id), error }, 'verification email failed to send');

  const revealed = mayRevealToken({ delivered: sent });
  return {
    sent,
    driver,
    /**
     * Why the send failed, so the UI can say something true.
     *
     * "No provider is configured" and "the provider refused this recipient" are
     * different problems with different fixes, and telling someone the wrong
     * one sends them to look in the wrong place.
     */
    error: error ?? null,
    mailConfigured: isMailConfigured(),
    // Never in production; never when the message actually went out.
    url: revealed ? url : null,
    token: revealed ? token : null,
    revealed,
  };
}

/**
 * Consumes a token.
 *
 * Every failure returns the same INVALID result rather than distinguishing
 * "no such token" from "wrong user": a caller holding a token learns only
 * whether it worked.
 */
export async function consumeVerification(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    return { result: VERIFY_RESULT.INVALID, user: null };
  }

  const record = await EmailVerification.findOne({ tokenHash: hashToken(rawToken) });
  if (!record) return { result: VERIFY_RESULT.INVALID, user: null };

  // A second click on the same link is not an error worth alarming anyone
  // about: say it is already done.
  if (record.usedAt) {
    const user = await User.findById(record.userId);
    return { result: VERIFY_RESULT.ALREADY_VERIFIED, user };
  }

  // The TTL index removes expired rows eventually, but "eventually" is not a
  // guarantee, so the check is explicit.
  if (record.expiresAt.getTime() < Date.now()) {
    return { result: VERIFY_RESULT.EXPIRED, user: null };
  }

  const user = await User.findById(record.userId);
  if (!user) return { result: VERIFY_RESULT.INVALID, user: null };

  // The address is re-read from the token, not from the user, so changing an
  // email after a token was issued cannot verify the new one by accident.
  if (user.email !== record.email) return { result: VERIFY_RESULT.INVALID, user: null };

  record.usedAt = new Date();
  await record.save();

  if (user.emailVerified) return { result: VERIFY_RESULT.ALREADY_VERIFIED, user };

  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  await user.save();

  logger.info({ userId: String(user._id) }, 'email verified');
  return { result: VERIFY_RESULT.VERIFIED, user };
}

/** For /api/health and the UI, so nobody has to guess whether mail works. */
export const mailStatus = () => ({
  configured: isMailConfigured(),
  driver: resolveDriver(),
});
