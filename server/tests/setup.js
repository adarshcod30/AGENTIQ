/**
 * Runs before any test module is imported.
 *
 * Deterministic env is set here rather than in a .env.test file so that a
 * developer's real .env can never influence a test result. dotenv does not
 * overwrite variables that are already set, so whatever is assigned here wins
 * over server/.env when config/env.js loads.
 */
process.env.NODE_ENV = 'test';

// 64 chars, obviously fake, never valid anywhere. The schema requires >= 32.
process.env.JWT_SECRET = 'test-only-secret-not-valid-anywhere-0000000000000000000000000000';

// Overridden per-file by mongodb-memory-server where a real DB is needed.
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/agentiq-test';

// Google OAuth deliberately left UNSET: the default test posture is an
// unconfigured server, the configuration most likely to break a fresh clone.
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

// Keep provider chips deterministic in health assertions.
delete process.env.GROQ_API_KEY;
delete process.env.BEDROCK_MODEL_ID;
delete process.env.RENDER_API_KEY;
