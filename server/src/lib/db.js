/**
 * MongoDB connection.
 *
 * This does NOT call process.exit() on failure. A library that kills the
 * process cannot be tested and cannot be reused by the migration script;
 * deciding whether a failure is fatal belongs to the caller (index.js exits,
 * tests do not).
 */
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// Mongoose 9 changed the strictQuery default; set it explicitly so behaviour
// does not depend on the installed minor version.
mongoose.set('strictQuery', true);

export async function connectDB(uri = env.MONGO_URI, options = {}) {
  if (!uri) throw new Error('connectDB: no MongoDB URI provided');
  const conn = await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    ...options,
  });
  // Log the host only: the URI carries credentials.
  logger.info({ host: conn.connection.host, db: conn.connection.name }, 'MongoDB connected');
  return conn;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}

/** Maps mongoose readyState to a word for /api/health. */
export function mongoStatus() {
  return (
    { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[
      mongoose.connection.readyState
    ] ?? 'unknown'
  );
}

export default connectDB;
