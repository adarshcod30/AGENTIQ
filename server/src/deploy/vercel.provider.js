/**
 * The Vercel deployment provider.
 *
 * Vercel deploys are multi-tenant: they use the CURRENT user's connected Vercel
 * token (Settings -> Connections), never a shared key, so the platform env
 * fallback isConfigured() is always false; the deploy route's per-user gate lets
 * a user through on their own connection.
 *
 * The deploy triggers a Git deployment through Vercel's REST API: it asks Vercel
 * to build the user's GitHub repo (their Vercel account must have the GitHub app
 * installed on that repo), then polls readyState to READY or a terminal failure.
 * Every request goes through fetchGuarded, so the same SSRF and rate rules apply.
 * VERCEL_API_BASE is overridable so the tests drive a local fake control plane.
 */
import { fetchGuarded } from '../mcp/egress.js';
import { env } from '../config/env.js';
import { getConnectionToken } from '../services/connections.service.js';
import { detectRequirements } from './requirements.js';
import { diagnoseFailure } from './diagnose.js';

/** Overridable so tests can point at a local fake control plane. */
export const VERCEL_API_BASE = () => env.VERCEL_API_BASE ?? 'https://api.vercel.com';

const READY = new Set(['READY']);
const FAILED = new Set(['ERROR', 'CANCELED', 'DELETED']);
const defaultSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** owner/name from a GitHub URL or an owner/name string. */
export function ownerRepo(repo) {
  const m = String(repo).match(/github\.com\/([^/]+)\/([^/.\s]+)/i);
  return m ? `${m[1]}/${m[2]}` : String(repo).replace(/\.git$/, '');
}

/** One Vercel API call through the egress guard. Returns { status, json }. */
async function vercelApi(url, { method = 'GET', body, token } = {}) {
  const res = await fetchGuarded(url, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* non-json body */ }
  return { status: res.status, json };
}

export const vercelProvider = {
  name: 'vercel',
  displayName: 'Vercel',
  status: 'available',
  requiresCredential: 'Vercel connection',
  // No platform env fallback: a user connects their own token in Settings.
  isConfigured: () => false,

  detectRequirements,
  diagnoseFailure,

  async preflight(input) {
    const repo = ownerRepo(input.repo);
    return {
      checks: [{
        name: 'provider',
        // Must be one of the Deployment model's check-status enum (pass|warn|fail).
        // 'ok' is not in that enum, so it failed the deployment record's save and
        // blocked every Vercel deploy before it could start.
        status: 'pass',
        detail: `Will deploy ${repo} to your connected Vercel account. Vercel must have access to the repo (its GitHub app installed).`,
      }],
      ok: true,
      needsGrant: false,
      parsed: { repo, serviceName: input.serviceName },
    };
  },

  async deploy(input, deps = {}) {
    const { context = {}, sleep = defaultSleep, pollIntervalMs = 4000, maxPolls = 40 } = deps;
    const base = (input.baseUrl ?? VERCEL_API_BASE()).replace(/\/+$/, '');

    const token = context.userId
      ? await getConnectionToken({ userId: context.userId, provider: 'vercel' }).catch(() => null)
      : null;
    if (!token) {
      throw Object.assign(
        new Error('Connect your Vercel account in Settings before deploying to Vercel.'),
        { code: 'DEPLOY_NOT_CONFIGURED' },
      );
    }

    const repo = ownerRepo(input.repo);
    const ref = input.branch ?? 'main';
    const name = input.serviceName ?? repo.split('/')[1] ?? 'app';

    if (input.dryRun) {
      return {
        ok: true, dryRun: true, serviceId: null, deployId: null, liveUrl: null, deployStatus: null,
        steps: [{ action: 'dry-run', message: `Would deploy ${repo}@${ref} to Vercel as ${name}`, at: new Date() }],
        message: `Dry run: would create a Vercel deployment for ${repo}.`,
        wouldSend: { provider: 'vercel', repo, ref, name },
      };
    }

    const steps = [];

    // 1. Trigger a git deployment.
    const create = await vercelApi(`${base}/v13/deployments`, {
      method: 'POST', token,
      body: { name, gitSource: { type: 'github', repo, ref } },
    });
    if (create.status >= 400 || !create.json?.id) {
      const msg = create.json?.error?.message ?? `Vercel rejected the deployment (HTTP ${create.status}).`;
      throw Object.assign(new Error(msg), { code: 'VERCEL_DEPLOY_FAILED' });
    }
    const deployId = create.json.id;
    steps.push({ action: 'create', message: `Vercel deployment ${deployId} created`, at: new Date() });

    // 2. Poll readyState until it settles.
    let status = create.json.readyState ?? 'QUEUED';
    let url = create.json.url ?? null;
    for (let i = 0; i < maxPolls && !READY.has(status) && !FAILED.has(status); i += 1) {
      await sleep(pollIntervalMs);
      const poll = await vercelApi(`${base}/v13/deployments/${encodeURIComponent(deployId)}`, { token });
      status = poll.json?.readyState ?? status;
      url = poll.json?.url ?? url;
    }

    const ok = READY.has(status);
    steps.push({ action: 'poll', message: `Vercel deployment ${status}`, at: new Date() });
    const liveUrl = url ? (url.startsWith('http') ? url : `https://${url}`) : null;

    return {
      ok,
      dryRun: false,
      serviceId: create.json.projectId ?? null,
      deployId,
      liveUrl,
      deployStatus: status,
      steps,
      message: ok ? `Deployed to Vercel: ${liveUrl}` : `Vercel deployment ended in state ${status}.`,
    };
  },
};

export default vercelProvider;
