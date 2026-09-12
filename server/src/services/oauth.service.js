/**
 * OAuth "Connect" flows for third-party accounts, layered on the same encrypted
 * Connection store as token paste (services/connections.service.js).
 *
 * The platform owner registers an OAuth app on a provider and sets its client id
 * and secret in the environment. A provider with no client id has OAuth disabled,
 * and the UI shows token paste only, which always works. Render is intentionally
 * absent: it has no general OAuth-token flow, so it stays token paste.
 *
 * Flow (SPA, no cookies):
 *   1. POST /oauth/start (authenticated) -> a provider authorize URL carrying a
 *      short-lived signed `state` that binds the flow to this user and provider.
 *   2. The provider redirects the browser to GET /oauth/callback with a code.
 *   3. The callback verifies the state, exchanges the code for a token through
 *      the egress guard, and stores it as the user's connection.
 *
 * The `state` is a signed JWT, so the public callback cannot be forged and needs
 * no server-side session storage.
 */
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { fetchGuarded } from '../mcp/egress.js';
import { setConnection } from './connections.service.js';

export class OAuthError extends Error {
  constructor(message, code = 'OAUTH_ERROR', status = 400) {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
    this.status = status;
  }
}

/** Per-provider config. Token URLs are overridable so tests drive a fake. */
const PROVIDERS = {
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: () => process.env.GITHUB_OAUTH_TOKEN_URL ?? 'https://github.com/login/oauth/access_token',
    scope: 'repo',
    clientId: () => process.env.GITHUB_OAUTH_CLIENT_ID ?? '',
    clientSecret: () => process.env.GITHUB_OAUTH_CLIENT_SECRET ?? '',
  },
  vercel: {
    authorizeUrl: 'https://vercel.com/oauth/authorize',
    tokenUrl: () => process.env.VERCEL_OAUTH_TOKEN_URL ?? 'https://api.vercel.com/v2/oauth/access_token',
    scope: '',
    clientId: () => process.env.VERCEL_CLIENT_ID ?? '',
    clientSecret: () => process.env.VERCEL_CLIENT_SECRET ?? '',
  },
};

/** { github: true|false, vercel: true|false }: which providers have OAuth wired. */
export function oauthProviders() {
  return Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, Boolean(PROVIDERS[p].clientId())]));
}

export function oauthAvailable(provider) {
  return Boolean(PROVIDERS[provider]?.clientId());
}

function redirectUri(provider) {
  return `${env.API_BASE_URL.replace(/\/+$/, '')}/api/connections/${provider}/oauth/callback`;
}

/** A short-lived signed state binding the flow to one user and provider (CSRF). */
function signState(userId, provider) {
  return jwt.sign(
    { sub: String(userId), provider, purpose: 'oauth-state' },
    env.JWT_SECRET, { expiresIn: '10m', algorithm: 'HS256' },
  );
}

function verifyState(state, provider) {
  let payload;
  try {
    payload = jwt.verify(state, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw new OAuthError('The connect request expired or was invalid. Start again.', 'BAD_STATE', 400);
  }
  if (payload.purpose !== 'oauth-state' || payload.provider !== provider) {
    throw new OAuthError('The connect request did not match. Start again.', 'BAD_STATE', 400);
  }
  return payload.sub;
}

/** The provider authorize URL to send the user's browser to. */
export function oauthStartUrl({ provider, userId }) {
  const cfg = PROVIDERS[provider];
  if (!cfg || !cfg.clientId()) {
    throw new OAuthError(`OAuth is not configured for ${provider}. Paste a token instead.`, 'OAUTH_NOT_CONFIGURED', 400);
  }
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('client_id', cfg.clientId());
  url.searchParams.set('redirect_uri', redirectUri(provider));
  if (cfg.scope) url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', signState(userId, provider));
  return url.toString();
}

/** Exchanges the authorization code for an access token (through the egress guard). */
async function exchangeCode(provider, code) {
  const cfg = PROVIDERS[provider];
  const form = new URLSearchParams({
    client_id: cfg.clientId(),
    client_secret: cfg.clientSecret(),
    code,
    redirect_uri: redirectUri(provider),
    grant_type: 'authorization_code',
  }).toString();

  const res = await fetchGuarded(cfg.tokenUrl(), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* non-json body */ }
  const token = json?.access_token;
  if (!token) {
    throw new OAuthError(
      json?.error_description || json?.error || `Token exchange failed (HTTP ${res.status}).`,
      'EXCHANGE_FAILED', 400,
    );
  }
  return token;
}

/**
 * The callback: verify state, exchange the code, store the connection. Returns
 * { userId, provider } so the route can redirect the browser back to Settings.
 */
export async function handleOAuthCallback({ provider, code, state }) {
  if (!PROVIDERS[provider]) throw new OAuthError(`Unknown OAuth provider: ${provider}`, 'UNKNOWN_PROVIDER', 400);
  if (!code) throw new OAuthError('No authorization code was returned by the provider.', 'NO_CODE', 400);
  const userId = verifyState(state, provider);
  const token = await exchangeCode(provider, code);
  await setConnection({ userId, provider, token });
  return { userId, provider };
}

export default { oauthProviders, oauthAvailable, oauthStartUrl, handleOAuthCallback, OAuthError };
