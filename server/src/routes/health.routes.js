/**
 * GET /api/health: liveness plus dependency status.
 *
 * docs/02_TRD.md §10 and §13. Also the target for the warm ping that mitigates
 * free-tier cold starts.
 *
 * Everything reported here is derived from real state. The frontend's provider
 * chip reads this endpoint rather than rendering a static badge, because a
 * hardcoded "Agents Online" chip asserts something nothing ever checked.
 */
import { Router } from 'express';
import { mongoStatus } from '../lib/db.js';
import { isGoogleOAuthConfigured } from '../config/passport.js';
import { env } from '../config/env.js';
import { providerOrder, modelFor, TASK } from '../services/llm.js';
import { mailStatus } from '../services/verification.service.js';
import { ok } from '../utils/http.js';

const router = Router();

/** Providers are "configured" only when a key is actually present. */
export function llmProviders() {
  return [
    { name: 'groq', configured: Boolean(env.GROQ_API_KEY), role: env.LLM_PRIMARY === 'groq' ? 'primary' : 'fallback' },
    { name: 'bedrock', configured: Boolean(env.BEDROCK_MODEL_ID), role: env.LLM_PRIMARY === 'bedrock' ? 'primary' : 'fallback' },
  ];
}

/**
 * The chain as it will ACTUALLY resolve, with the model each task will use.
 *
 * Worth reporting rather than inferring from configuration: providerOrder()
 * silently drops a provider whose credentials or model id are missing, so
 * "LLM_PRIMARY=bedrock" in the environment does not mean bedrock is the one
 * answering. That gap ran an entire evaluation phase on the wrong provider
 * before anyone noticed. One request to /api/health now settles it.
 */
export function llmChain() {
  const order = providerOrder();
  return {
    order,
    hasFallback: order.length > 1,
    models: Object.fromEntries(
      Object.values(TASK).map((task) => [
        task,
        Object.fromEntries(order.map((p) => [p, modelFor(task, p)])),
      ]),
    ),
  };
}

router.get('/health', (req, res) => {
  const mongo = mongoStatus();
  return ok(res, {
    status: mongo === 'connected' ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    mongo,
    llmProviders: llmProviders(),
    llmChain: llmChain(),
    // Whether verification mail can actually be delivered, and by what.
    mail: mailStatus(),
    googleOAuth: isGoogleOAuthConfigured() ? 'configured' : 'disabled',
    // True on the shared public deployment: the UI hides the local-folder
    // workflow, which only works when AGENTIQ runs on the user's own machine.
    hosted: env.HOSTED,
    env: env.NODE_ENV,
  });
});

export default router;
