/**
 * Per-user third-party connections (GitHub / Render / Vercel tokens): encrypted
 * at rest, listed as presence only, decrypted only for server-side use. The key
 * property under test: a token goes IN and never comes back out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { createApp } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Connection } from '../src/models/Connection.js';
import { encryptSecret, decryptSecret } from '../src/services/crypto.service.js';
import {
  setConnection, listConnections, getConnectionToken, removeConnection,
} from '../src/services/connections.service.js';

const app = createApp({ logging: false });
let token;
let userId;

beforeAll(async () => { await connectTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Connection.deleteMany({})]);
  const res = await request(app).post('/api/auth/register').send({
    displayName: 'Dev', email: 'conn@example.com', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery',
  });
  token = res.body.data.token;
  userId = (await User.findOne({ email: 'conn@example.com' }))._id;
});

describe('crypto.service', () => {
  it('round-trips a secret and detects tampering', () => {
    const enc = encryptSecret('ghp_supersecrettoken123');
    expect(enc).not.toContain('ghp_supersecrettoken123');
    expect(decryptSecret(enc)).toBe('ghp_supersecrettoken123');

    // Tamper with the ciphertext bytes, not its base64url characters. The
    // ciphertext is 23 bytes, so the final base64url character carries four
    // data bits and two unused low bits, and swapping it between 'A' and 'B'
    // moves only those unused bits. Whenever that character landed in
    // {A, B, C, D} the "tampered" token decoded to the identical bytes, GCM
    // verified it happily, and this test failed on about one run in sixteen.
    // Flipping a byte before re-encoding always changes what GCM sees.
    const parts = enc.split(':');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});

describe('connections service', () => {
  it('stores a token encrypted, lists presence only, and reads it back server-side', async () => {
    await setConnection({ userId, provider: 'render', token: 'rnd_live_abcdefgh1234' });

    const row = await Connection.findOne({ userId, provider: 'render' }).select('+secret');
    expect(row.secret).not.toContain('rnd_live_abcdefgh1234'); // encrypted at rest
    expect(row.last4).toBe('1234');

    const list = await listConnections({ userId });
    const render = list.find((c) => c.provider === 'render');
    expect(render.connected).toBe(true);
    expect(render.last4).toBe('1234');
    expect(JSON.stringify(list)).not.toContain('rnd_live_abcdefgh1234'); // never the token

    expect(await getConnectionToken({ userId, provider: 'render' })).toBe('rnd_live_abcdefgh1234');

    await removeConnection({ userId, provider: 'render' });
    expect(await getConnectionToken({ userId, provider: 'render' })).toBeNull();
  });

  it('rejects an unknown provider and a too-short token', async () => {
    await expect(setConnection({ userId, provider: 'aws', token: 'x'.repeat(20) })).rejects.toThrow(/Unknown provider/i);
    await expect(setConnection({ userId, provider: 'github', token: 'short' })).rejects.toThrow(/too short/i);
  });
});

describe('connections HTTP', () => {
  it('PUT stores, GET returns presence without the token, DELETE removes', async () => {
    const put = await request(app).put('/api/connections/vercel')
      .set('Authorization', `Bearer ${token}`).send({ token: 'vercel_tok_abcd9999' });
    expect(put.status).toBe(200);

    const get = await request(app).get('/api/connections').set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    const vercel = get.body.data.connections.find((c) => c.provider === 'vercel');
    expect(vercel.connected).toBe(true);
    expect(vercel.last4).toBe('9999');
    expect(JSON.stringify(get.body)).not.toContain('vercel_tok_abcd9999');

    const del = await request(app).delete('/api/connections/vercel').set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    const get2 = await request(app).get('/api/connections').set('Authorization', `Bearer ${token}`);
    expect(get2.body.data.connections.find((c) => c.provider === 'vercel').connected).toBe(false);
  });

  it('requires auth', async () => {
    expect((await request(app).get('/api/connections')).status).toBe(401);
  });
});
