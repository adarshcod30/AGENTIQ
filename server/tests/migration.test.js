/**
 * User migration, exercised against a scratch in-memory database seeded with
 * realistic legacy data, including the awkward case the old schema allowed:
 * the same person present in both `users` and `gusers`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { planMigration, applyMigration } from '../scripts/migrate-users.js';
import { User } from '../src/models/User.js';

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

beforeEach(async () => {
  await User.deleteMany({});
  const db = mongoose.connection.db;
  await db.collection('users').deleteMany({});
  await db.collection('gusers').deleteMany({});
});

/** Seeds the two legacy collections exactly as the old schema shaped them. */
async function seedLegacy() {
  const db = mongoose.connection.db;
  const hash = await bcrypt.hash('old-password', 10); // legacy hashes used cost 10
  await db.collection('users').insertMany([
    { fullName: 'Local Only', email: 'local@example.com', password: hash, profilePicture: '', role: 'user' },
    { fullName: 'Both Ways', email: 'Both@Example.com', password: hash, profilePicture: '', role: 'admin' },
  ]);
  await db.collection('gusers').insertMany([
    { fullName: 'Google Only', email: 'google@example.com', profilePicture: 'https://img/g.png', role: 'user' },
    { fullName: 'Both Ways', email: 'both@example.com', profilePicture: 'https://img/b.png', role: 'user' },
  ]);
  return { hash };
}

async function readLegacy() {
  const db = mongoose.connection.db;
  return {
    local: await db.collection('users').find({}).toArray(),
    google: await db.collection('gusers').find({}).toArray(),
  };
}

describe('planMigration', () => {
  it('merges 2 + 2 legacy records into 3 users', async () => {
    await seedLegacy();
    const { users, problems } = planMigration(await readLegacy());
    expect(users).toHaveLength(3);
    expect(problems).toEqual([]);
  });

  it('collapses a person present in both collections into ONE document with TWO providers', async () => {
    await seedLegacy();
    const { users } = planMigration(await readLegacy());
    const both = users.find((u) => u.email === 'both@example.com');
    expect(both.authProviders.map((p) => p.provider).sort()).toEqual(['google', 'local']);
    expect(users.filter((u) => u.email === 'both@example.com')).toHaveLength(1);
  });

  it('normalises email case when matching across collections', async () => {
    await seedLegacy();
    // 'Both@Example.com' in users and 'both@example.com' in gusers are one person.
    const { users } = planMigration(await readLegacy());
    expect(users.every((u) => u.email === u.email.toLowerCase())).toBe(true);
  });

  it('carries the existing bcrypt hash across rather than inventing one', async () => {
    const { hash } = await seedLegacy();
    const { users } = planMigration(await readLegacy());
    expect(users.find((u) => u.email === 'local@example.com').passwordHash).toBe(hash);
  });

  it('leaves google-only users without a password hash', async () => {
    await seedLegacy();
    const { users } = planMigration(await readLegacy());
    expect(users.find((u) => u.email === 'google@example.com').passwordHash).toBeUndefined();
  });

  it('preserves an admin role found on either record', async () => {
    await seedLegacy();
    const { users } = planMigration(await readLegacy());
    expect(users.find((u) => u.email === 'both@example.com').role).toBe('admin');
  });

  it('reports, and does not crash on, a record with no email', async () => {
    const db = mongoose.connection.db;
    await db.collection('users').insertOne({ fullName: 'Broken', password: 'x' });
    const { users, problems } = planMigration(await readLegacy());
    expect(users).toHaveLength(0);
    expect(problems[0]).toMatch(/no email/);
  });
});

/** Runs the real end-to-end migration against the seeded scratch DB. */
async function runMigration() {
  const db = mongoose.connection.db;
  const { users } = planMigration(await readLegacy());
  return applyMigration(db, users);
}

describe('applyMigration (end-to-end against a scratch DB)', () => {
  it('upgrades legacy documents in place and inserts google-only ones', async () => {
    await seedLegacy();
    const result = await runMigration();
    expect(result).toEqual({ upgraded: 2, inserted: 1, untouched: 0 });
    expect(await User.countDocuments({})).toBe(3);
  });

  it('preserves _id on upgrade, so existing TestRun references stay valid', async () => {
    await seedLegacy();
    const before = await mongoose.connection.db
      .collection('users').findOne({ email: 'local@example.com' });
    await runMigration();
    const after = await User.findOne({ email: 'local@example.com' });
    expect(String(after._id)).toBe(String(before._id));
  });

  it('removes the legacy field names once their values are copied across', async () => {
    await seedLegacy();
    await runMigration();
    const raw = await mongoose.connection.db
      .collection('users').findOne({ email: 'local@example.com' });
    expect(raw.fullName).toBeUndefined();
    expect(raw.password).toBeUndefined();
    expect(raw.profilePicture).toBeUndefined();
    expect(raw.displayName).toBe('Local Only');
    expect(raw.passwordHash).toBeTypeOf('string');
  });

  it('is idempotent: a second run changes nothing', async () => {
    await seedLegacy();
    await runMigration();
    const second = await runMigration();
    expect(second).toEqual({ upgraded: 0, inserted: 0, untouched: 3 });
    expect(await User.countDocuments({})).toBe(3);
  });

  it('a migrated password still verifies (cost-10 hashes remain valid)', async () => {
    await seedLegacy();
    await runMigration();
    const user = await User.findOne({ email: 'local@example.com' }).select('+passwordHash');
    expect(await user.verifyPassword('old-password')).toBe(true);
    expect(await user.verifyPassword('wrong')).toBe(false);
  });

  it('a migrated user authenticates through the real login endpoint', async () => {
    await seedLegacy();
    await runMigration();
    const { createApp } = await import('../src/app.js');
    const request = (await import('supertest')).default;
    const res = await request(createApp({ logging: false }))
      .post('/api/auth/login')
      .send({ email: 'local@example.com', password: 'old-password' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.displayName).toBe('Local Only');
  });

  it('the placeholder google providerId is upgraded on first real sign-in', async () => {
    await seedLegacy();
    await runMigration();
    const user = await User.findOne({ email: 'google@example.com' });
    // gusers never stored a Google id, so the migration seeds the email.
    expect(user.authProviders[0].providerId).toBe('google@example.com');

    user.linkProvider({ provider: 'google', providerId: '1179284', email: 'google@example.com' });
    await user.save();

    // Upgraded in place, not appended as a duplicate provider.
    expect(user.authProviders).toHaveLength(1);
    expect(user.authProviders[0].providerId).toBe('1179284');
  });

  it('does not drop the legacy gusers collection', async () => {
    await seedLegacy();
    await runMigration();
    const remaining = await mongoose.connection.db.collection('gusers').countDocuments({});
    expect(remaining).toBe(2);
  });
});
