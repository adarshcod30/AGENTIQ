/**
 * Auth integration tests against a real in-memory MongoDB.
 *
 * Covers the unified User model (docs/02_TRD.md §9) and the defects it is
 * designed to prevent: the password hash reaching the client, split user
 * collections, and email enumeration on login.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { createApp } from '../src/app.js';
import { User, BCRYPT_COST } from '../src/models/User.js';

const app = createApp({ logging: false });

const CREDENTIALS = {
  displayName: 'Adarsh Dwivedi',
  email: 'Adarsh@Example.com',
  password: 'correct-horse-battery',
  confirmPassword: 'correct-horse-battery',
};

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await User.deleteMany({});
});

describe('POST /api/auth/register', () => {
  it('creates a user and returns a token', async () => {
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTypeOf('string');
    expect(res.body.data.user.email).toBe('adarsh@example.com'); // normalised
  });

  it('NEVER returns the password hash', async () => {
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS);
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(res.body.data.user).not.toHaveProperty('password');
    expect(JSON.stringify(res.body)).not.toContain('$2b$');
  });

  it('records a local auth provider rather than creating a second collection', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS);
    const user = await User.findOne({ email: 'adarsh@example.com' });
    expect(user.authProviders).toHaveLength(1);
    expect(user.authProviders[0].provider).toBe('local');
  });

  it('stores a bcrypt hash at the configured cost, never the plaintext', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS);
    const user = await User.findOne({ email: 'adarsh@example.com' }).select('+passwordHash');
    expect(user.passwordHash).not.toBe(CREDENTIALS.password);
    expect(user.passwordHash).toMatch(new RegExp(`^\\$2[aby]\\$${BCRYPT_COST}\\$`));
  });

  it('rejects mismatched passwords with field-level detail', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...CREDENTIALS, confirmPassword: 'different' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field === 'confirmPassword')).toBe(true);
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS);
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/api/auth/register').send(CREDENTIALS);
  });

  it('accepts correct credentials, case-insensitively on email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ADARSH@example.com', password: CREDENTIALS.password });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTypeOf('string');
  });

  it('does not leak which accounts exist (identical response either way)', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: 'wrong' });
    const noSuchUser = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong' });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.body).toEqual(noSuchUser.body);
  });
});

describe('GET /api/auth/me', () => {
  let token;
  beforeEach(async () => {
    const res = await request(app).post('/api/auth/register').send(CREDENTIALS);
    token = res.body.data.token;
  });

  it('returns the current user for a valid bearer token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('adarsh@example.com');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a tampered token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}x`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('rejects a token signed with a different secret', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const forged = jwt.sign({ sub: new mongoose.Types.ObjectId().toString() }, 'a'.repeat(48));
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});

describe('User model', () => {
  it('links a second provider onto the same document, not a new one', async () => {
    const user = new User({
      email: 'dual@example.com',
      displayName: 'Dual',
      authProviders: [{ provider: 'local', providerId: 'dual@example.com', email: 'dual@example.com' }],
    });
    user.linkProvider({ provider: 'google', providerId: 'g-123', email: 'dual@example.com' });
    await user.save();

    expect(await User.countDocuments({ email: 'dual@example.com' })).toBe(1);
    expect(user.hasProvider('google')).toBe(true);
    expect(user.hasProvider('local')).toBe(true);
  });

  it('is idempotent when linking the same provider twice', async () => {
    const user = new User({
      email: 'idem@example.com',
      displayName: 'Idem',
      authProviders: [{ provider: 'google', providerId: 'g-1', email: 'idem@example.com' }],
    });
    user.linkProvider({ provider: 'google', providerId: 'g-1', email: 'idem@example.com' });
    expect(user.authProviders).toHaveLength(1);
  });

  it('requires at least one auth provider', async () => {
    const user = new User({ email: 'orphan@example.com', displayName: 'Orphan', authProviders: [] });
    await expect(user.save()).rejects.toThrow(/auth provider/i);
  });
});
