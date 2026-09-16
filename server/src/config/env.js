/**
 * Environment validation.
 *
 * Every variable in docs/02_TRD.md §12 is declared here and validated with Zod
 * at boot. The server prints a readable table of what is set and what is
 * missing, then exits non-zero if a REQUIRED variable is absent or malformed.
 *
 * There is no fallback for JWT_SECRET and there never will be. A hardcoded
 * default eventually ends up in a public repository; failing loudly at boot is
 * cheap to fix, whereas a silent default is a forged-token vulnerability that
 * looks like a working server.
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const SERVER_DIR = path.resolve(import.meta.dirname, '../..');
const REPO_ROOT = path.resolve(SERVER_DIR, '..');

/**
 * Load .env files. dotenv does not overwrite variables that are already set, so
 * the first file to define a key wins, and real environment variables (as set by
 * Render, CI, or the shell) always beat both files.
 */
export function loadDotenv() {
  // Never read a developer's .env during tests. dotenv skips variables that are
  // already set, but tests legitimately *delete* variables to assert the
  // unconfigured path, and a deleted variable looks unset, so dotenv would
  // refill it from disk. That makes results depend on whose machine is running:
  // green locally with credentials present, red in CI without them.
  if (process.env.NODE_ENV === 'test') return;

  dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });
  dotenv.config({ path: path.join(SERVER_DIR, '.env'), quiet: true });
}

/** "true"/"1"/"yes" -> true. Anything else -> false. z.coerce.boolean() is wrong
 *  here: it uses JS truthiness, so the string "false" would coerce to true. */
const boolFromString = z
  .string()
  .optional()
  .transform((v) => ['true', '1', 'yes', 'on'].includes(String(v).trim().toLowerCase()));

const port = z.coerce.number().int().positive().max(65535);

const GENERATE_SECRET = 'Generate one with: ' +
  "node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3001),

    // ── Required ─────────────────────────────────────────────────────────────
    MONGO_URI: z.string({ error: 'MONGO_URI is required' }).min(1, { error: 'MONGO_URI is required' }),
    JWT_SECRET: z.string({ error: `JWT_SECRET is required. ${GENERATE_SECRET}` }).min(32, {
      error: `JWT_SECRET must be at least 32 characters. ${GENERATE_SECRET}`,
    }),

    // ── Origins ──────────────────────────────────────────────────────────────
    CORS_ORIGIN: z.string().default('http://localhost:5173'),
    APP_BASE_URL: z.url().default('http://localhost:5173'),
    API_BASE_URL: z.url().default('http://localhost:3001'),

    // ── LLM providers ────────────────────────────────────────────────────────
    // Bedrock is the primary provider and Groq the fallback. Bedrock reaches many
    // model families through one interface, so a third bespoke provider key
    // would add nothing. See docs/05_AWS_ARCHITECTURE.md.
    GROQ_API_KEY: z.string().optional(),
    // Providers retire models on their own schedule; keep this swappable.
    GROQ_MODEL: z.string().optional(),
    // Per-task overrides: see TASK_MODELS in services/llm.js.
    GROQ_MODEL_EXPLAIN: z.string().optional(),
    BEDROCK_MODEL_EXPLAIN: z.string().optional(),
    LLM_PRIMARY: z.enum(['groq', 'bedrock']).default('bedrock'),
    LLM_FALLBACK: z.enum(['groq', 'bedrock']).default('groq'),

    // ── AWS (optional: see docs/05_AWS_ARCHITECTURE.md) ──────────────────────
    // Deliberately no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY: credentials come
    // from the default chain locally, an instance role on App Runner, and OIDC in
    // CI. A long-lived AWS key must never be read from a file in this repo.
    //
    // Declare a variable here only in the same change that adds the code reading
    // it. Declared-but-unread config is worse than absent config: setting it
    // clears the "Disabled" line at boot, which reads as a feature switching on.
    AWS_REGION: z.string().default('ap-south-1'),
    BEDROCK_MODEL_ID: z.string().optional(),

    // ── Google OAuth (optional: absence must not break boot) ──────────────────
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),

    // ── Email (optional: absence disables verification mail, not the app) ────
    // Three drivers, chosen by resolveDriver() in services/mailer.service.js.
    // Gmail SMTP (MAIL_DRIVER=smtp) delivers to any address with only an app
    // password. Resend's shared onboarding@ sender delivers only to the account
    // owner until a domain is verified. Anything unusable falls back to console.
    MAIL_DRIVER: z.enum(['resend', 'smtp', 'console']).optional(),
    RESEND_API_KEY: z.string().optional(),
    SMTP_URL: z.string().optional(),
    // The simple Gmail path: see smtpConfigured() in services/mailer.service.js.
    GMAIL_USER: z.string().optional(),
    GMAIL_APP_PASSWORD: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    MAIL_FROM: z.string().optional(),

    // ── Deployment (optional) ────────────────────────────────────────────────
    RENDER_API_KEY: z.string().optional(),
    // Overridable so the deployment tests can drive a local fake control plane
    // instead of creating real services in a real Render account.
    RENDER_API_BASE: z.string().url().optional(),

    // ── Logging ──────────────────────────────────────────────────────────────
    // Read directly via process.env in lib/logger.js (mcp/stdio.js overwrites it
    // to 'silent' before the logger is imported, so it cannot come from `env`).
    // Declared here purely so an invalid level fails validation with a readable
    // message instead of throwing from inside pino at boot.
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).optional(),

    // ── Deployment mode ──────────────────────────────────────────────────────
    // HOSTED=true means this server is a shared, multi-user deployment (the
    // public site) rather than a copy someone runs on their own machine. A
    // remote user's "project folder" lives on THEIR laptop, which this server
    // cannot see, so local-filesystem project roots are refused: they would
    // either error confusingly or, worse, let a remote user point discovery at
    // the server's own files (its .env holds every secret). Hosted users assess
    // a deployed URL or a public GitHub repo instead. Defaults false so a local
    // self-hosted run keeps the folder workflow.
    HOSTED: boolFromString,

    // The interface the HTTP server binds. Unset binds all interfaces (fine for
    // local dev). Behind a reverse proxy set HOST=127.0.0.1 so the app is only
    // reachable through the proxy, never directly, even if the firewall slips.
    HOST: z.string().optional(),

    // ── Egress guard ─────────────────────────────────────────────────────────
    EGRESS_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    EGRESS_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
    EGRESS_RPS_PER_HOST: z.coerce.number().int().positive().default(5),
    ALLOW_PRIVATE_TARGETS: boolFromString,
  })
  .refine((e) => !(e.NODE_ENV === 'production' && e.ALLOW_PRIVATE_TARGETS), {
    error:
      'ALLOW_PRIVATE_TARGETS=true is refused when NODE_ENV=production. It exists only for ' +
      'local testing against the fixture apps and would turn the server into an SSRF proxy.',
    path: ['ALLOW_PRIVATE_TARGETS'],
  })
  .refine((e) => e.LLM_PRIMARY !== e.LLM_FALLBACK, {
    error: 'LLM_PRIMARY and LLM_FALLBACK must differ, otherwise there is no fallback.',
    path: ['LLM_FALLBACK'],
  });

/** Variables that are optional but whose absence disables a feature. */
export const OPTIONAL_FEATURE_VARS = {
  GOOGLE_CLIENT_ID: 'Google OAuth sign-in',
  GOOGLE_CLIENT_SECRET: 'Google OAuth sign-in',
  GROQ_API_KEY: 'Groq LLM provider',
  BEDROCK_MODEL_ID: 'Bedrock LLM provider',
  RENDER_API_KEY: 'Deployment agent',
  RESEND_API_KEY: 'Verification email',
  GMAIL_APP_PASSWORD: 'Verification email over Gmail SMTP',
};

/**
 * Optional features, and what actually enables each one.
 *
 * `mode: 'any'` matters. The previous version derived this list per VARIABLE,
 * so a server sending verification mail perfectly well through Gmail SMTP was
 * announced at boot as "Disabled: Verification email": purely because
 * RESEND_API_KEY happened to be absent. Telling an operator a working feature
 * is off is the same class of mistake as the LLM chain silently resolving to a
 * provider nobody chose: the startup output has to describe reality.
 */
export const OPTIONAL_FEATURES = [
  { name: 'Google OAuth sign-in', mode: 'all', requires: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
  { name: 'Groq LLM provider', mode: 'all', requires: ['GROQ_API_KEY'] },
  { name: 'Bedrock LLM provider', mode: 'all', requires: ['BEDROCK_MODEL_ID'] },
  { name: 'Deployment agent', mode: 'all', requires: ['RENDER_API_KEY'] },
  // Any ONE of three drivers is enough to send mail.
  { name: 'Verification email', mode: 'any', requires: ['RESEND_API_KEY', 'GMAIL_APP_PASSWORD', 'SMTP_URL'] },
];

/** Features that genuinely cannot work with the given environment. */
export function disabledFeatures(source = process.env) {
  const present = (k) => Boolean(source[k]);
  return OPTIONAL_FEATURES
    .filter(({ mode, requires }) => (mode === 'any'
      ? !requires.some(present)
      : !requires.every(present)))
    .map(({ name }) => name);
}

const SECRET_KEYS = new Set([
  'JWT_SECRET', 'MONGO_URI', 'GROQ_API_KEY',
  'GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'RENDER_API_KEY',
  'RESEND_API_KEY', 'SMTP_URL', 'GMAIL_APP_PASSWORD',
]);

/** Never print a secret. Show only enough to confirm the right value is loaded. */
export function maskValue(key, value) {
  if (value === undefined || value === '') return '';
  const s = String(value);
  if (!SECRET_KEYS.has(key)) return s;
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/**
 * Pure parse. Returns a result instead of exiting, so tests can exercise the
 * failure paths without killing the test runner.
 */
export function parseEnv(source = process.env) {
  // A blank value (`KEY=` in a .env file) means unset. dotenv reads it as an
  // empty string, which would fail every enum and URL field and skip every
  // default, so copying .env.example and filling in only the required values
  // would not boot.
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const result = envSchema.safeParse(present);
  return result.success
    ? { ok: true, env: result.data, issues: [] }
    : { ok: false, env: null, issues: result.error.issues };
}

/**
 * The only variables with no default and no fallback. Everything else either
 * defaults or degrades a single feature, so only these two can read "missing".
 */
export const REQUIRED_KEYS = ['MONGO_URI', 'JWT_SECRET'];

/**
 * Defaults, resolved once by parsing a minimal valid object. Computed rather
 * than duplicated so the table cannot disagree with the schema.
 */
function schemaDefaults() {
  const probe = envSchema.safeParse({ MONGO_URI: 'mongodb://x/y', JWT_SECRET: 'x'.repeat(32) });
  return probe.success ? probe.data : {};
}

/** Renders the set/default/missing table printed at boot. Returns lines. */
export function formatEnvTable(source = process.env, parsed = null) {
  const names = ENV_KEYS;
  const defaults = schemaDefaults();
  const width = Math.max(...names.map((k) => k.length));
  const lines = [`  ${'VARIABLE'.padEnd(width)}  STATUS    VALUE`];
  lines.push(`  ${'-'.repeat(width)}  --------  -----`);

  for (const key of names) {
    const raw = source[key];
    const isSet = raw !== undefined && raw !== '';

    // Falls back to the schema's own defaults when validation failed, so a
    // failing boot does not report 18 problems when only two are real.
    const effective = parsed?.[key] ?? defaults[key];

    let status;
    if (isSet) status = 'set';
    else if (REQUIRED_KEYS.includes(key)) status = 'MISSING';
    else if (key in OPTIONAL_FEATURE_VARS) status = 'off';
    else if (effective !== undefined) status = 'default';
    else status = 'unset';

    const shown = isSet
      ? maskValue(key, raw)
      : status === 'default' ? String(effective) : '';
    lines.push(`  ${key.padEnd(width)}  ${status.padEnd(8)}  ${shown}`);
  }
  return lines;
}

/**
 * Declared order for the boot table. Explicit rather than derived from the Zod
 * schema: .refine() wraps the object schema, so .shape is not reachable without
 * touching Zod internals that change between versions.
 *
 * The env.schema.test.js suite asserts this list matches the schema exactly, so
 * the two cannot drift apart silently.
 */
export const ENV_KEYS = [
  'NODE_ENV', 'PORT', 'MONGO_URI', 'JWT_SECRET', 'CORS_ORIGIN',
  'APP_BASE_URL', 'API_BASE_URL', 'GROQ_API_KEY',
  'GROQ_MODEL', 'GROQ_MODEL_EXPLAIN', 'BEDROCK_MODEL_EXPLAIN',
  'LLM_PRIMARY', 'LLM_FALLBACK',
  'AWS_REGION', 'BEDROCK_MODEL_ID',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'MAIL_DRIVER', 'RESEND_API_KEY', 'SMTP_URL', 'MAIL_FROM',
  'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'SMTP_HOST', 'SMTP_PORT',
  'RENDER_API_KEY', 'RENDER_API_BASE', 'LOG_LEVEL', 'HOSTED', 'HOST',
  'EGRESS_TIMEOUT_MS', 'EGRESS_MAX_BYTES',
  'EGRESS_RPS_PER_HOST', 'ALLOW_PRIVATE_TARGETS',
];

/**
 * Boot-time load. Prints the table, then exits non-zero if validation failed.
 * Called by index.js only: app.js imports the already-validated config.
 */
export function loadEnv({ exit = true, log = console } = {}) {
  loadDotenv();
  const result = parseEnv(process.env);

  log.info?.('\nAGENTIQ: environment');
  for (const line of formatEnvTable(process.env, result.env)) log.info?.(line);

  const disabled = disabledFeatures(process.env);
  if (disabled.length) {
    log.info?.(`\n  Disabled (optional config absent): ${[...new Set(disabled)].join(', ')}`);
  }

  if (!result.ok) {
    log.error?.('\n  Environment validation FAILED:\n');
    for (const issue of result.issues) {
      log.error?.(`    ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    log.error?.('\n  Copy .env.example to .env and fill in the required values.\n');
    if (exit) process.exit(1);
    return null;
  }

  log.info?.('');
  return result.env;
}

/**
 * The validated config used across the app.
 *
 * Parsed without exiting so that importing a module does not kill a test run;
 * index.js calls loadEnv() explicitly at boot and that is what enforces the
 * hard failure.
 */
loadDotenv();
const parsed = parseEnv(process.env);
export const env = parsed.env ?? {};
export const envIsValid = parsed.ok;
export default env;
