/**
 * Test database helper.
 *
 * Two ways to get a MongoDB:
 *
 *   MONGO_TEST_URI set  ->  connect to it (CI uses a `mongo` service container)
 *   otherwise           ->  spin up mongodb-memory-server (zero local setup)
 *
 * Why both: mongodb-memory-server downloads a mongod binary on first use, which
 * is fine on a developer machine where it caches, but on a fresh CI runner it is
 * a network download on the critical path and a well-known source of flaky or
 * failing builds. A service container is already running before the job starts,
 * so CI becomes deterministic and faster while local development keeps needing
 * no setup at all.
 */
import mongoose from 'mongoose';

let memoryServer = null;

export async function connectTestDb() {
  const external = process.env.MONGO_TEST_URI;

  if (external) {
    // Each test file runs in its own forked process (vitest pool: 'forks') and
    // gets its own database, so files cannot see each other's documents.
    // dbName is passed as an option rather than spliced into the URI: string
    // surgery on a connection string is how you end up connecting to "mongodb:/".
    const dbName = `agentiq_test_${process.pid}`;
    await mongoose.connect(external, { dbName, serverSelectionTimeoutMS: 15_000 });
    return mongoose.connection;
  }

  const { MongoMemoryServer } = await import('mongodb-memory-server');
  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri());
  return mongoose.connection;
}

export async function disconnectTestDb() {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

/** Empties every collection between tests without dropping the database. */
export async function clearTestDb() {
  const { collections } = mongoose.connection;
  await Promise.all(
    Object.values(collections).map((c) => c.deleteMany({})),
  );
}
