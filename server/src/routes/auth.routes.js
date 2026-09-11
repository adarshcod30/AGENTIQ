/**
 * /api/auth/*
 *
 * The Google routes are registered unconditionally but check configuration at
 * request time, so an unconfigured server returns an explanatory 503 instead of
 * a 404 or a failure to boot.
 */
import { Router } from 'express';
import passport from 'passport';
import rateLimit from 'express-rate-limit';
import {
  registerUser, loginUser, logoutUser, currentUser, googleCallback,
  verifyEmail, resendVerification,
} from '../controllers/auth.controller.js';
import { protectRoute } from '../middleware/auth.js';
import { isGoogleOAuthConfigured, GOOGLE_STRATEGY } from '../config/passport.js';
import { fail } from '../utils/http.js';
import { env } from '../config/env.js';

const router = Router();

router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/logout', logoutUser);
router.get('/me', protectRoute, currentUser);

/**
 * POST, not GET. A GET would be prefetched by mail clients and corporate link
 * scanners, burning the single-use token before the recipient ever clicks it.
 * The emailed link points at the frontend, which posts here.
 *
 * Unauthenticated: someone verifying from a phone will not be signed in there.
 */
router.post('/verify', verifyEmail);

/**
 * Resend is rate-limited HARDER than the rest of /api/auth.
 *
 * The shared auth limiter allows 20 posts per 15 minutes, which is fine for
 * login attempts and far too generous here: this endpoint causes an email to be
 * delivered to a third party, so an attacker with one account could use it to
 * flood their own inbox, or, worse, register with someone else's address and
 * use resend to harass them. Three per fifteen minutes is enough for a genuine
 * "it did not arrive" and useless as a weapon.
 *
 * Keyed by USER, not IP: two people behind one NAT should not consume each
 * other's budget, and the route is authenticated so the user is always known.
 */
const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id ?? req.ip),
  skip: () => env.NODE_ENV === 'test',
  message: {
    success: false,
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many verification emails requested. Try again in a few minutes.',
    },
  },
});

/** Authenticated, so there is no address parameter to enumerate accounts with. */
router.post('/verify/resend', protectRoute, resendLimiter, resendVerification);

/** Refuses cleanly when Google credentials are absent. */
function requireGoogle(req, res, next) {
  if (!isGoogleOAuthConfigured()) {
    return fail(
      res,
      503,
      'OAUTH_NOT_CONFIGURED',
      'Google sign-in is not configured on this server. Use email and password, or set ' +
        'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    );
  }
  return next();
}

router.get('/google', requireGoogle, (req, res, next) =>
  passport.authenticate(GOOGLE_STRATEGY, {
    scope: ['profile', 'email'],
    session: false,
    prompt: 'select_account',
  })(req, res, next),
);

router.get(
  '/google/callback',
  requireGoogle,
  (req, res, next) =>
    passport.authenticate(GOOGLE_STRATEGY, {
      session: false,
      failureRedirect: `${env.APP_BASE_URL}/login?error=google_auth_failed`,
    })(req, res, next),
  googleCallback,
);

export default router;
