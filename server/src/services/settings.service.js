/**
 * The self-host configuration surface (bring your own key).
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §G, §H, Phase 7. AGENTIQ does not store your API
 * keys. Per §G, credentials are supplied through the environment (a .env file
 * for local use, your host's secrets in production) or per request, never
 * committed and never logged; §I keeps a per-tenant credential vault out of
 * local scope on purpose. So this surface reports, for each capability, which
 * environment variables it needs, whether they are present, and how to obtain
 * them. It reads presence only. It never reads, returns or logs a value.
 */
import { OPTIONAL_FEATURES } from '../config/env.js';
import { listProviders } from '../deploy/index.js';

/** How to obtain each key. Guidance only; never a value. */
const GUIDANCE = {
  GROQ_API_KEY: 'Create an API key at console.groq.com and set GROQ_API_KEY.',
  BEDROCK_MODEL_ID:
    'Set BEDROCK_MODEL_ID to a model you can call, and supply AWS credentials through the default '
    + 'provider chain (an IAM role or the shared config file), never committed keys.',
  RENDER_API_KEY: 'Create an API key in Render (Account Settings, API Keys) and set RENDER_API_KEY.',
  RAILWAY_TOKEN: 'Create a token in Railway (Account, Tokens) and set RAILWAY_TOKEN.',
  GOOGLE_CLIENT_ID: 'From an OAuth 2.0 Client ID in Google Cloud Console.',
  GOOGLE_CLIENT_SECRET: 'From the same OAuth 2.0 Client in Google Cloud Console.',
  RESEND_API_KEY: 'Create an API key at resend.com and set RESEND_API_KEY.',
  GMAIL_APP_PASSWORD: 'A Gmail app password (not your account password), with GMAIL_USER set.',
  SMTP_URL: 'A full smtp:// or smtps:// URL for your own mail server.',
};

const guidanceFor = (key) => GUIDANCE[key] ?? `Set ${key} in the environment.`;

/**
 * Builds the config surface from the environment. `source` is injectable so a
 * test can pass a controlled environment rather than mutate process.env.
 */
export function buildConfigSurface(source = process.env) {
  const present = (k) => Boolean(source[k]);

  const capabilities = OPTIONAL_FEATURES.map(({ name, mode, requires }) => ({
    name,
    mode,
    configured: mode === 'any' ? requires.some(present) : requires.every(present),
    keys: requires.map((key) => ({ key, present: present(key), guidance: guidanceFor(key) })),
  }));

  // Deployment providers, resolved against the SAME source as everything else so
  // the whole surface reflects one environment. Each provider names the credential
  // it needs; its presence in `source` is what "configured" means here.
  const deployProviders = listProviders().map((p) => ({
    name: p.name,
    displayName: p.displayName,
    status: p.status,
    configured: p.requiresCredential ? present(p.requiresCredential) : p.configured,
    key: p.requiresCredential,
    guidance: guidanceFor(p.requiresCredential),
  }));

  return {
    byok:
      'AGENTIQ never stores your API keys. Provide them in the server environment: a .env file for '
      + 'local use, or your host\'s secret store in production. Deployment credentials may instead be '
      + 'supplied per request. Nothing here is written to the database or sent to the browser.',
    capabilities,
    deployProviders,
  };
}

export default { buildConfigSurface };
