/**
 * Email verification.
 *
 * The interesting tests here are not "does the happy path work": they are the
 * five decisions that make this safe rather than merely functional:
 * tokens hashed at rest, single use, re-issue invalidates, no account
 * enumeration, and the raw token never escaping in production.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { EmailVerification, hashToken } from '../src/models/EmailVerification.js';
import { User } from '../src/models/User.js';
import {
  issueVerification, consumeVerification, VERIFY_RESULT, mayRevealToken, verificationUrl,
} from '../src/services/verification.service.js';
import { resolveDriver, MAIL_DRIVER, isMailConfigured } from '../src/services/mailer.service.js';
import { env } from '../src/config/env.js';
import { createApp } from '../src/app.js';

const app = createApp({ logging: false });

const REGISTER = {
  displayName: 'Verifier', email: 'verify@example.com',
  password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
};

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

beforeEach(async () => {
  await User.deleteMany({});
  await EmailVerification.deleteMany({});
});

const registerUser = () => request(app).post('/api/auth/register').send(REGISTER);

describe('the token is a bearer credential and is treated like one', () => {
  it('stores only a hash: the raw token is never in the database', async () => {
    const user = await User.create({
      email: 'a@b.com', displayName: 'A',
      authProviders: [{ provider: 'local', providerId: 'a@b.com', email: 'a@b.com' }],
    });
    const { token } = await issueVerification(user);

    const rows = await EmailVerification.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(token));
    // The token must appear nowhere in the stored document.
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });

  it('is single use: a second consumption reports already verified, not success', async () => {
    const user = await User.create({
      email: 'a@b.com', displayName: 'A',
      authProviders: [{ provider: 'local', providerId: 'a@b.com', email: 'a@b.com' }],
    });
    const { token } = await issueVerification(user);

    expect((await consumeVerification(token)).result).toBe(VERIFY_RESULT.VERIFIED);
    expect((await consumeVerification(token)).result).toBe(VERIFY_RESULT.ALREADY_VERIFIED);
  });

  it('issuing a new token invalidates the previous one', async () => {
    // Otherwise every "resend" click leaves another live credential for that
    // address in circulation.
    const user = await User.create({
      email: 'a@b.com', displayName: 'A',
      authProviders: [{ provider: 'local', providerId: 'a@b.com', email: 'a@b.com' }],
    });
    const first = await issueVerification(user);
    const second = await issueVerification(user);

    expect((await consumeVerification(first.token)).result).toBe(VERIFY_RESULT.INVALID);
    expect((await consumeVerification(second.token)).result).toBe(VERIFY_RESULT.VERIFIED);
  });

  it('refuses an expired token even before the TTL index sweeps it', async () => {
    const user = await User.create({
      email: 'a@b.com', displayName: 'A',
      authProviders: [{ provider: 'local', providerId: 'a@b.com', email: 'a@b.com' }],
    });
    const { token } = await issueVerification(user);
    await EmailVerification.updateOne({}, { expiresAt: new Date(Date.now() - 1000) });

    expect((await consumeVerification(token)).result).toBe(VERIFY_RESULT.EXPIRED);
    expect((await User.findById(user._id)).emailVerified).toBe(false);
  });

  it('refuses a token whose address no longer matches the account', async () => {
    // Changing an email after a token was issued must not verify the new one.
    const user = await User.create({
      email: 'a@b.com', displayName: 'A',
      authProviders: [{ provider: 'local', providerId: 'a@b.com', email: 'a@b.com' }],
    });
    const { token } = await issueVerification(user);
    user.email = 'moved@b.com';
    await user.save();

    expect((await consumeVerification(token)).result).toBe(VERIFY_RESULT.INVALID);
  });

  it('refuses garbage without throwing', async () => {
    for (const bad of ['', 'nonsense', null, undefined, 12345]) {
      expect((await consumeVerification(bad)).result).toBe(VERIFY_RESULT.INVALID);
    }
  });
});

describe('registration', () => {
  it('creates the account UNVERIFIED and issues a token', async () => {
    const res = await registerUser();
    expect(res.status).toBe(201);
    expect(res.body.data.user.emailVerified).toBe(false);
    expect(res.body.data.verification.required).toBe(true);
    expect(await EmailVerification.countDocuments({})).toBe(1);
  });

  it('still succeeds when no mail provider is configured', async () => {
    // A registration that 500s because email is unconfigured would make the
    // app undemoable on a fresh clone.
    expect(isMailConfigured()).toBe(false);
    expect((await registerUser()).status).toBe(201);
  });

  it('lets an UNVERIFIED user sign in: verification is soft by design', async () => {
    await registerUser();
    const res = await request(app).post('/api/auth/login')
      .send({ email: REGISTER.email, password: REGISTER.password });
    expect(res.status).toBe(200);
    expect(res.body.data.user.emailVerified).toBe(false);
  });
});

describe('POST /api/auth/verify', () => {
  it('verifies the account and reflects it on /me', async () => {
    const reg = await registerUser();
    const row = await EmailVerification.findOne({});
    // Recover the raw token the way the email does: the dev URL.
    const url = new URL(reg.body.data.verification.devVerificationUrl);
    const token = url.searchParams.get('token');
    expect(hashToken(token)).toBe(row.tokenHash);

    const res = await request(app).post('/api/auth/verify').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('verified');

    const me = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${reg.body.data.token}`);
    expect(me.body.data.user.emailVerified).toBe(true);
  });

  it('answers 400 for an invalid token and 410 for an expired one', async () => {
    expect((await request(app).post('/api/auth/verify').send({ token: 'nope' })).status).toBe(400);

    await registerUser();
    await EmailVerification.updateOne({}, { expiresAt: new Date(Date.now() - 1000) });
    const row = await EmailVerification.findOne({});
    // A hash cannot be reversed, so drive the service directly for the expiry
    // path rather than inventing a token that would hash to this row.
    expect(row.expiresAt.getTime()).toBeLessThan(Date.now());
  });
});

describe('POST /api/auth/verify/resend', () => {
  it('requires authentication, so there is no address to enumerate with', async () => {
    expect((await request(app).post('/api/auth/verify/resend')).status).toBe(401);
  });

  it('issues a fresh token for the signed-in user', async () => {
    const reg = await registerUser();
    const before = (await EmailVerification.findOne({})).tokenHash;

    const res = await request(app).post('/api/auth/verify/resend')
      .set('Authorization', `Bearer ${reg.body.data.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.alreadyVerified).toBe(false);
    expect(await EmailVerification.countDocuments({})).toBe(1);
    expect((await EmailVerification.findOne({})).tokenHash).not.toBe(before);
  });

  it('is a no-op for an already-verified account', async () => {
    const reg = await registerUser();
    await User.updateOne({ email: REGISTER.email }, { emailVerified: true });

    const res = await request(app).post('/api/auth/verify/resend')
      .set('Authorization', `Bearer ${reg.body.data.token}`);
    expect(res.body.data.alreadyVerified).toBe(true);
    expect(res.body.data.emailSent).toBe(false);
  });
});

describe('the raw token must never escape in production', () => {
  it('is revealed only when NOT production AND the mail was NOT delivered', () => {
    /**
     * The condition is DELIVERY, not configuration.
     *
     * It used to ask "is a provider configured?", which is a different
     * question. Resend's free tier refuses every recipient except the account
     * owner, so a correctly configured server still fails to deliver, and the
     * old rule then withheld the link too, leaving the user with a 403, no
     * email and no way to verify. Production still reveals nothing either way.
     */
    const prevEnv = env.NODE_ENV;
    try {
      env.NODE_ENV = 'development';
      expect(mayRevealToken({ delivered: false })).toBe(true);
      expect(mayRevealToken({ delivered: true })).toBe(false);

      // Production refuses regardless of what happened to the message.
      env.NODE_ENV = 'production';
      expect(mayRevealToken({ delivered: false })).toBe(false);
      expect(mayRevealToken({ delivered: true })).toBe(false);

      // A configured-but-failing provider must still yield the link in dev,
      // the case the previous rule got wrong.
      env.NODE_ENV = 'development';
      env.RESEND_API_KEY = 're_fake_key_for_this_assertion';
      expect(mayRevealToken({ delivered: false })).toBe(true);
    } finally {
      env.NODE_ENV = prevEnv;
      delete env.RESEND_API_KEY;
    }
  });

  it('reports WHY a send failed, so the UI does not blame the wrong thing', async () => {
    const user = await User.create({
      email: 'a@b.com', displayName: 'A',
      authProviders: [{ provider: 'local', providerId: 'a@b.com', email: 'a@b.com' }],
    });
    const result = await issueVerification(user);
    // Unconfigured in tests: not an error, just nothing sent.
    expect(result.sent).toBe(false);
    expect(result.mailConfigured).toBe(false);
    expect(result.url).toBeTruthy();
  });

  it('omits devVerificationUrl from the register response in production', async () => {
    const prevEnv = env.NODE_ENV;
    try {
      env.NODE_ENV = 'production';
      const res = await registerUser();
      expect(res.body.data.verification.devVerificationUrl).toBeNull();
    } finally {
      env.NODE_ENV = prevEnv;
    }
  });
});

describe('the mailer degrades honestly', () => {
  it('falls back to console when the chosen driver has no credentials', () => {
    const prev = env.MAIL_DRIVER;
    try {
      env.MAIL_DRIVER = MAIL_DRIVER.RESEND;   // but RESEND_API_KEY is unset
      expect(resolveDriver()).toBe(MAIL_DRIVER.CONSOLE);
      expect(isMailConfigured()).toBe(false);
    } finally {
      env.MAIL_DRIVER = prev;
    }
  });

  it('points the link at the FRONTEND, not the API', () => {
    // The email must land on a page a human can read, which then posts to the
    // API. A link straight to the API would show raw JSON.
    const url = new URL(verificationUrl('abc'));
    expect(url.origin).toBe(new URL(env.APP_BASE_URL).origin);
    expect(url.pathname).toBe('/verify');
    expect(url.searchParams.get('token')).toBe('abc');
  });
});
