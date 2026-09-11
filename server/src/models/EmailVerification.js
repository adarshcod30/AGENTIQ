/**
 * Email-verification tokens.
 *
 * ── THE TOKEN IS HASHED AT REST ─────────────────────────────────────────────
 * Only a SHA-256 of the token is stored, exactly as with a password. A
 * verification token is a bearer credential: whoever holds it can prove
 * ownership of an email address. Storing it in the clear would mean a database
 * leak hands an attacker the ability to verify accounts they do not own, and a
 * project whose whole subject is API security should not keep bearer tokens in
 * plaintext.
 *
 * SHA-256 rather than bcrypt is deliberate and worth being able to defend:
 * these tokens are 32 bytes of CSPRNG output, so there is no dictionary to
 * attack and no need for a slow KDF. The reason to hash a password slowly is
 * that humans pick guessable ones. Nothing here is guessable.
 *
 * ── EXPIRY IS ENFORCED BY MONGO, NOT BY A CRON ──────────────────────────────
 * The TTL index deletes expired rows automatically, so an abandoned token
 * cannot sit around for months. `usedAt` is kept rather than deleting on use so
 * a second click on the same link can say "already verified" instead of "this
 * link is invalid", which is a confusing thing to show someone who did nothing
 * wrong.
 */
import mongoose from 'mongoose';
import { createHash, randomBytes } from 'node:crypto';

/** How long a link stays valid. Long enough to survive a spam folder. */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const emailVerificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The address this token proves ownership of, captured at issue time. */
    email: { type: String, required: true, lowercase: true, trim: true },
    /** SHA-256 of the token. The token itself is never stored. */
    tokenHash: { type: String, required: true, unique: true, index: true },
    usedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Mongo removes the document once expiresAt passes. No cleanup job to forget.
emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** 32 bytes of CSPRNG output, URL-safe so it survives an email client. */
export const generateToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

export const EmailVerification =
  mongoose.models.EmailVerification
  ?? mongoose.model('EmailVerification', emailVerificationSchema, 'emailverifications');

export default EmailVerification;
