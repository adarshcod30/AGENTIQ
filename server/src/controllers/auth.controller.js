/**
 * Email/password and Google authentication.
 *
 *   - Responses never include the password hash (see User.toJSON).
 *   - A freshly minted JWT is never logged.
 *   - Registration and login share one collection.
 *   - Cookies are secure and sameSite=none only in production. Set
 *     unconditionally, browsers silently drop them over plain http in local
 *     development (see cookieOptions in utils/token.js).
 */
import { z } from 'zod';
import { User } from '../models/User.js';
import { generateToken, cookieOptions } from '../utils/token.js';
import { ok, fail, ApiError } from '../utils/http.js';
import { env } from '../config/env.js';
import {
  issueVerification, consumeVerification, VERIFY_RESULT, mailStatus,
} from '../services/verification.service.js';
import { logger } from '../lib/logger.js';

const registerSchema = z
  .object({
    displayName: z.string().trim().min(1, { error: 'Name is required' }).max(80),
    email: z.email({ error: 'Enter a valid email address' }),
    password: z.string().min(8, { error: 'Password must be at least 8 characters' }).max(200),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    error: 'Passwords do not match',
    path: ['confirmPassword'],
  });

const loginSchema = z.object({
  email: z.email({ error: 'Enter a valid email address' }),
  password: z.string().min(1, { error: 'Password is required' }),
});

/** Turns a Zod error into the envelope's `details` shape. */
function fieldErrors(zodError) {
  return zodError.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
}

export async function registerUser(req, res) {
  const parsed = registerSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors(parsed.error));
  }
  const { displayName, email, password } = parsed.data;

  if (await User.exists({ email })) {
    return fail(res, 409, 'EMAIL_IN_USE', 'An account with this email already exists');
  }

  const user = new User({
    email,
    displayName,
    authProviders: [{ provider: 'local', providerId: email, email }],
  });
  await user.setPassword(password);
  await user.save();

  const token = generateToken(user);
  res.cookie('token', token, cookieOptions());

  /**
   * Issued but NOT awaited as a precondition of success. Registration has
   * already happened; a mail provider outage must not roll it back or return a
   * 500 to someone whose account now exists. The response reports honestly
   * whether the message went out.
   */
  const verification = await issueVerification(user).catch((err) => {
    logger.error({ err: err.message }, 'could not issue verification token');
    return { sent: false, driver: null, url: null, revealed: false };
  });

  // toJSON strips passwordHash; see models/User.js.
  return ok(res, {
    user: user.toJSON(),
    token,
    verification: {
      required: true,
      emailSent: verification.sent,
      // Non-null only outside production AND only when mail is unconfigured,
      // see mayRevealToken() in verification.service.js.
      devVerificationUrl: verification.url,
    },
  }, 201);
}

/**
 * POST /api/auth/verify: consume a token.
 *
 * Deliberately a POST. A GET would be followed by mail clients and link
 * scanners that prefetch URLs, silently burning single-use tokens before the
 * recipient ever clicks. The emailed link points at the FRONTEND, which posts
 * here.
 */
export async function verifyEmail(req, res) {
  const token = String(req.body?.token ?? req.query?.token ?? '');
  const { result, user } = await consumeVerification(token);

  if (result === VERIFY_RESULT.VERIFIED || result === VERIFY_RESULT.ALREADY_VERIFIED) {
    return ok(res, {
      result,
      alreadyVerified: result === VERIFY_RESULT.ALREADY_VERIFIED,
      user: user ? user.toJSON() : null,
    });
  }

  if (result === VERIFY_RESULT.EXPIRED) {
    return fail(res, 410, 'VERIFICATION_EXPIRED',
      'This link has expired. Sign in and request a new one.');
  }
  return fail(res, 400, 'VERIFICATION_INVALID',
    'This link is not valid. It may already have been used.');
}

/**
 * POST /api/auth/verify/resend: issue a fresh token.
 *
 * Authenticated, so it resends for the signed-in account only. That removes
 * the enumeration question entirely: there is no email parameter to probe
 * with, and no way to ask this endpoint about an address you cannot already
 * sign in as.
 */
export async function resendVerification(req, res) {
  const user = req.user;

  if (user.emailVerified) {
    return ok(res, { alreadyVerified: true, emailSent: false });
  }

  const verification = await issueVerification(user).catch((err) => {
    logger.error({ err: err.message }, 'resend failed');
    return { sent: false, url: null, error: err.message, mailConfigured: false };
  });

  return ok(res, {
    alreadyVerified: false,
    emailSent: verification.sent,
    devVerificationUrl: verification.url,
    // Distinguishes "no provider" from "the provider refused this recipient".
    mailConfigured: verification.mailConfigured ?? false,
    mailError: verification.error ?? null,
    mail: mailStatus(),
  });
}

export async function loginUser(req, res) {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return fail(res, 400, 'VALIDATION_ERROR', 'Check the highlighted fields', fieldErrors(parsed.error));
  }
  const { email, password } = parsed.data;

  // passwordHash is select:false, so ask for it explicitly.
  const user = await User.findOne({ email }).select('+passwordHash');

  // Same response whether the account is missing or the password is wrong,
  // otherwise this endpoint enumerates registered emails.
  const invalid = () => fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  if (!user) return invalid();
  if (!(await user.verifyPassword(password))) return invalid();

  const token = generateToken(user);
  res.cookie('token', token, cookieOptions());
  return ok(res, { user: user.toJSON(), token });
}

export function logoutUser(req, res) {
  res.clearCookie('token', { ...cookieOptions(), maxAge: undefined });
  return ok(res, { loggedOut: true });
}

export function currentUser(req, res) {
  return ok(res, { user: req.user.toJSON() });
}

/**
 * Google callback. Passport has authenticated the profile; we find-or-create the
 * user, link the provider, mint a JWT, and hand it to the frontend.
 */
export async function googleCallback(req, res) {
  const profile = req.user;
  const email = profile?.emails?.[0]?.value?.toLowerCase();
  if (!email) throw ApiError.badRequest('Google account did not return an email address');

  let user = await User.findOne({ email });
  if (!user) {
    user = new User({
      email,
      displayName: profile.displayName || email.split('@')[0],
      avatarUrl: profile.photos?.[0]?.value ?? '',
      authProviders: [],
    });
  }
  // Link rather than create a second document: one person, one user, many
  // sign-in methods.
  user.linkProvider({ provider: 'google', providerId: profile.id, email });
  if (!user.avatarUrl && profile.photos?.[0]?.value) user.avatarUrl = profile.photos[0].value;

  /**
   * Google has already proved ownership of this address, so re-proving it is
   * friction with no security value.
   *
   * The check is on Google's OWN verified flag rather than on the mere presence
   * of an email: a Workspace or unverified account can carry an address Google
   * has not confirmed, and trusting that would let someone verify an address
   * they do not own by signing in with a doctored profile.
   */
  const googleVerified = profile?.emails?.[0]?.verified;
  if (!user.emailVerified && googleVerified !== false) {
    user.emailVerified = true;
    user.emailVerifiedAt = new Date();
  }
  await user.save();

  const token = generateToken(user);
  res.cookie('token', token, cookieOptions());

  const target = new URL('/google-success', env.APP_BASE_URL);
  target.searchParams.set('token', token);
  return res.redirect(target.toString());
}
