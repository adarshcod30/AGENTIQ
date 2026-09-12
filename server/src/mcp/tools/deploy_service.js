/**
 * deploy_service: the only tool that mutates infrastructure outside AGENTIQ.
 *
 * docs/01_PRD.md F5. Targets Render's REST API.
 *
 * WHY RENDER AND NOT APP RUNNER. These are two different questions:
 *
 *   - WHERE AGENTIQ RUNS  → AWS (docs/05_AWS_ARCHITECTURE.md).
 *   - WHERE THE DEPLOYMENT AGENT DEPLOYS *THE USER'S* API TO → Render.
 *
 * Render is the target because F5's acceptance criterion is a deployment that
 * verifies itself, and Render exposes a synchronous deploy-status endpoint plus
 * a stable live URL within a minute or two. App Runner's create-service call
 * takes 5 to 10 minutes to reach RUNNING, which would turn the verify step into
 * a background job rather than something the user can watch happen.
 *
 * ── THE CREDENTIAL ──────────────────────────────────────────────────────────
 * RENDER_API_KEY is read from the environment INSIDE this handler. It is
 * deliberately absent from inputSchema. If it were an input field it would flow
 * into hashInput(), into any validation error that echoes the input, and into
 * every future debug log someone adds. There is no code path here by which a
 * caller supplies it or an error prints it, and redact() scrubs it from any
 * message the provider hands back.
 *
 * ── ONE TOOL, EXPLICIT ACTIONS ──────────────────────────────────────────────
 * Every Render call is a separate `action`, so every call is a separate audit
 * row. "Deployed the service" is not one event; it is find_owner → find_service
 * → create_service → trigger_deploy → deploy_status xN, and the audit log shows
 * each one.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';
import { env } from '../../config/env.js';
import { getConnectionToken } from '../../services/connections.service.js';

/** Overridable so tests can point at a local fake control plane. */
export const RENDER_API_BASE = () => env.RENDER_API_BASE ?? 'https://api.render.com/v1';

/**
 * Whose Render key to deploy with. The user's OWN connected token wins (this is
 * a multi-tenant product: a user deploys to their own Render account), and the
 * platform RENDER_API_KEY is the fallback for the owner or an MCP client with no
 * user context.
 */
async function resolveRenderKey(userId) {
  if (userId) {
    const token = await getConnectionToken({ userId, provider: 'render' }).catch(() => null);
    if (token) return token;
  }
  return env.RENDER_API_KEY;
}

/** Render deploy statuses that mean "stop polling". */
export const TERMINAL_SUCCESS = new Set(['live']);
export const TERMINAL_FAILURE = new Set([
  'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated',
]);
export const isTerminal = (s) => TERMINAL_SUCCESS.has(s) || TERMINAL_FAILURE.has(s);

/**
 * Scrubs anything that looks like a Render credential out of a string.
 *
 * Belt and braces: the key should never reach here, but provider error bodies
 * sometimes echo request context, and an audit `reason` column containing a
 * live API key would be a genuinely serious leak rather than an embarrassing
 * one. Matches both the configured value and the rnd_ prefix shape.
 */
export function redact(text) {
  let out = String(text ?? '');
  const key = env.RENDER_API_KEY;
  if (key && key.length > 6) out = out.split(key).join('«redacted»');
  return out.replace(/\brnd_[A-Za-z0-9_-]{6,}/g, 'rnd_«redacted»');
}

export const inputSchema = z.object({
  provider: z.enum(['render']).default('render'),

  action: z.enum([
    'find_owner',     // GET  /owners              whose account are we deploying into
    'find_service',   // GET  /services?name=      does it already exist
    'create_service', // POST /services            MUTATING
    'trigger_deploy', // POST /services/:id/deploys  MUTATING
    'deploy_status',  // GET  /services/:id/deploys/:deployId
    'service_info',   // GET  /services/:id        for the live URL
  ]),

  /* Present so the audit row records WHICH control plane was contacted. */
  baseUrl: z.url().optional(),

  serviceName: z.string().min(1).max(90).optional(),
  serviceId: z.string().min(1).optional(),
  deployId: z.string().min(1).optional(),
  ownerId: z.string().min(1).optional(),

  repo: z.url().optional(),
  branch: z.string().min(1).default('main'),
  runtime: z.enum(['node', 'python', 'ruby', 'go', 'docker']).default('node'),
  plan: z.enum(['free', 'starter', 'standard']).default('free'),
  region: z.enum(['oregon', 'frankfurt', 'singapore', 'ohio', 'virginia']).default('oregon'),
  buildCommand: z.string().max(400).default('npm install'),
  startCommand: z.string().max(400).default('npm start'),
  envVars: z.record(z.string(), z.string()).default({}),

  /**
   * Renders the request WITHOUT sending it. Not a mock: the returned body is
   * the exact payload that would go on the wire, and `dryRun: true` is on the
   * result so no caller can mistake it for a deployment that happened.
   */
  dryRun: z.boolean().default(false),
});

export const outputSchema = z.object({
  action: z.string(),
  dryRun: z.boolean(),
  ok: z.boolean(),
  status: z.number().nullable(),
  ownerId: z.string().nullable(),
  serviceId: z.string().nullable(),
  deployId: z.string().nullable(),
  deployStatus: z.string().nullable(),
  liveUrl: z.string().nullable(),
  existed: z.boolean().nullable(),
  wouldSend: z.record(z.string(), z.unknown()).nullable(),
  message: z.string(),
});

const blank = {
  ownerId: null, serviceId: null, deployId: null, deployStatus: null,
  liveUrl: null, existed: null, wouldSend: null,
};

class DeployError extends Error {
  constructor(message, code = 'DEPLOY_FAILED') {
    super(redact(message));
    this.name = 'DeployError';
    this.code = code;
  }
}

/**
 * One authenticated call to Render, through the SSRF guard like everything else.
 *
 * The guard applies even though api.render.com is a known host: exempting
 * "trusted" hosts is how egress controls rot, and RENDER_API_BASE is
 * overridable, so an unguarded path here would be a real hole.
 */
async function callRender(path, { method = 'GET', body, apiKey, base }) {
  const res = await fetchGuarded(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    timeoutMs: 20_000,
  });

  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* non-JSON body handled below */ }

  if (res.status === 401 || res.status === 403) {
    throw new DeployError(
      `Render rejected the credential (${res.status}). Check RENDER_API_KEY is a valid API key ` +
      'with access to this account.',
      'DEPLOY_UNAUTHORIZED',
    );
  }
  if (res.status >= 400) {
    const detail = parsed?.message ?? parsed?.error ?? res.body.slice(0, 300);
    throw new DeployError(`Render ${method} ${path} failed with ${res.status}: ${detail}`);
  }

  return { status: res.status, json: parsed, raw: res.body };
}

/** Render list endpoints wrap each row: [{ cursor, service: {...} }]. */
const unwrap = (rows, key) =>
  (Array.isArray(rows) ? rows : []).map((r) => r?.[key] ?? r).filter(Boolean);

/**
 * Renders a mutating request WITHOUT sending it.
 *
 * This is not a mock: `dryRun: true` rides on the result and the body is the
 * exact payload that would go on the wire, so no caller can read it as a
 * deployment that happened. envVars VALUES are replaced with «set»: the plan
 * has to be reviewable without printing the caller's secrets back at them.
 */
export function renderDryRun(input, target, body) {
  return {
    action: input.action, dryRun: true, ok: true, status: null, ...blank,
    serviceId: input.serviceId ?? null,
    wouldSend: {
      target,
      method: 'POST',
      body: body.envVars
        ? { ...body, envVars: body.envVars.map((e) => ({ key: e.key, value: '«set»' })) }
        : body,
    },
    message:
      `DRY RUN: nothing was sent. This is the request that would go to ${target}. ` +
      'No infrastructure was changed.',
  };
}

export default defineTool({
  name: 'deploy_service',
  title: 'Deploy service',
  description:
    'Create or trigger a Render deployment and read its status. The only tool that changes ' +
    'systems outside AGENTIQ: requires a deploy.write grant AND explicit per-action ' +
    'confirmation. Set dryRun to render the request without sending it.',
  riskClass: RISK_CLASS.DEPLOY_WRITE,
  inputSchema,
  outputSchema,

  async handler(input, context) {
    const base = (input.baseUrl ?? RENDER_API_BASE()).replace(/\/+$/, '');
    const apiKey = await resolveRenderKey(context?.userId);

    if (!apiKey) {
      // An honest unconfigured state, not a fabricated success.
      throw new DeployError(
        'No Render credential is available, so no deployment can be attempted. Connect your Render '
        + 'account in Settings, or set RENDER_API_KEY in the server environment.',
        'DEPLOY_NOT_CONFIGURED',
      );
    }

    switch (input.action) {
      /* ── read: whose account ──────────────────────────────────────────── */
      case 'find_owner': {
        const { json } = await callRender('/owners?limit=1', { apiKey, base });
        const owner = unwrap(json, 'owner')[0];
        if (!owner?.id) {
          throw new DeployError('No Render owner is associated with this API key.');
        }
        return {
          action: input.action, dryRun: false, ok: true, status: 200, ...blank,
          ownerId: owner.id,
          message: `Deploying into Render account "${owner.name ?? owner.id}".`,
        };
      }

      /* ── read: does the service already exist ─────────────────────────── */
      case 'find_service': {
        const q = encodeURIComponent(input.serviceName ?? '');
        const { json } = await callRender(`/services?name=${q}&limit=20`, { apiKey, base });
        // Render's name filter is a prefix match, so confirm an exact hit.
        const svc = unwrap(json, 'service').find((s) => s.name === input.serviceName);
        return {
          action: input.action, dryRun: false, ok: true, status: 200, ...blank,
          existed: Boolean(svc),
          serviceId: svc?.id ?? null,
          liveUrl: svc?.serviceDetails?.url ?? null,
          message: svc
            ? `Service "${input.serviceName}" already exists (${svc.id}); a deploy will be triggered on it.`
            : `No service named "${input.serviceName}"; one will be created.`,
        };
      }

      /* ── MUTATING: create ─────────────────────────────────────────────── */
      case 'create_service': {
        if (!input.repo) throw new DeployError('create_service requires a repo URL.', 'VALIDATION_ERROR');
        if (!input.ownerId) throw new DeployError('create_service requires an ownerId.', 'VALIDATION_ERROR');

        const body = {
          type: 'web_service',
          name: input.serviceName,
          ownerId: input.ownerId,
          repo: input.repo,
          branch: input.branch,
          autoDeploy: 'no', // AGENTIQ triggers deploys explicitly; no silent pushes.
          serviceDetails: {
            env: input.runtime,
            plan: input.plan,
            region: input.region,
            envSpecificDetails: {
              buildCommand: input.buildCommand,
              startCommand: input.startCommand,
            },
          },
          envVars: Object.entries(input.envVars).map(([key, value]) => ({ key, value })),
        };

        if (input.dryRun) return renderDryRun(input, `POST ${base}/services`, body);

        const { json, status } = await callRender('/services', { method: 'POST', body, apiKey, base });
        const service = json?.service ?? json;
        return {
          action: input.action, dryRun: false, ok: true, status, ...blank,
          serviceId: service?.id ?? null,
          deployId: json?.deployId ?? null,
          liveUrl: service?.serviceDetails?.url ?? null,
          existed: false,
          message: `Created Render service "${input.serviceName}" (${service?.id}).`,
        };
      }

      /* ── MUTATING: deploy ─────────────────────────────────────────────── */
      case 'trigger_deploy': {
        if (!input.serviceId) throw new DeployError('trigger_deploy requires a serviceId.', 'VALIDATION_ERROR');

        const path = `/services/${encodeURIComponent(input.serviceId)}/deploys`;
        if (input.dryRun) return renderDryRun(input, `POST ${base}${path}`, { clearCache: 'do_not_clear' });

        const { json, status } = await callRender(path, {
          method: 'POST', body: { clearCache: 'do_not_clear' }, apiKey, base,
        });
        return {
          action: input.action, dryRun: false, ok: true, status, ...blank,
          serviceId: input.serviceId,
          deployId: json?.id ?? null,
          deployStatus: json?.status ?? null,
          message: `Triggered deploy ${json?.id} on ${input.serviceId}.`,
        };
      }

      /* ── read: poll ───────────────────────────────────────────────────── */
      case 'deploy_status': {
        if (!input.serviceId || !input.deployId) {
          throw new DeployError('deploy_status requires serviceId and deployId.', 'VALIDATION_ERROR');
        }
        const { json, status } = await callRender(
          `/services/${encodeURIComponent(input.serviceId)}/deploys/${encodeURIComponent(input.deployId)}`,
          { apiKey, base },
        );
        const deployStatus = json?.status ?? 'unknown';
        return {
          action: input.action, dryRun: false, ok: true, status, ...blank,
          serviceId: input.serviceId,
          deployId: input.deployId,
          deployStatus,
          message: `Deploy ${input.deployId} is ${deployStatus}.`,
        };
      }

      /* ── read: the live URL ───────────────────────────────────────────── */
      case 'service_info': {
        if (!input.serviceId) throw new DeployError('service_info requires a serviceId.', 'VALIDATION_ERROR');
        const { json, status } = await callRender(
          `/services/${encodeURIComponent(input.serviceId)}`, { apiKey, base },
        );
        const service = json?.service ?? json;
        return {
          action: input.action, dryRun: false, ok: true, status, ...blank,
          serviceId: input.serviceId,
          liveUrl: service?.serviceDetails?.url ?? null,
          message: service?.serviceDetails?.url
            ? `Service is reachable at ${service.serviceDetails.url}.`
            : 'Service has no public URL yet.',
        };
      }

      /* c8 ignore next 3: Zod's enum already refuses anything else. */
      default:
        throw new DeployError(`Unsupported action: ${input.action}`, 'VALIDATION_ERROR');
    }

  },
});
