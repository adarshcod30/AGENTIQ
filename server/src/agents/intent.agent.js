/**
 * INTENT AGENT: infer what a discovered endpoint is FOR, from its code.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D. Phase 1 discovery is deterministic and
 * finds the surface; it does not interpret it. This agent is the interpretation
 * step: given an endpoint and the source of its handler, it asks the model what
 * the endpoint appears to do, how confident it is, and whether anything is
 * genuinely ambiguous.
 *
 * ⚠️ NO I/O. Like every agent, it only calls the LLM service (a fixed
 * first-party endpoint) and returns a value. The handler SOURCE is read for it
 * by the fs_read tool, in the orchestrator, and passed in.
 *
 * The confidence and the clarification exist to drive the clarification loop:
 * when the model cannot tell whether a parameter is required, or what a route
 * does, the platform asks the user rather than guessing (docs/10 §10).
 */
import { z } from 'zod';
import { generateJSON, TASK } from '../services/llm.js';

export const intentSchema = z.object({
  /** One sentence: what this endpoint appears to do. */
  intent: z.string().min(1).max(400),
  /** How sure the model is, given the code it saw. */
  confidence: z.enum(['low', 'medium', 'high']),
  /**
   * A specific question for the user when something material is ambiguous, or
   * null when nothing needs clarifying. Kept concrete: "is patientId required?"
   * rather than "please clarify".
   */
  clarification: z.string().max(300).nullable().default(null),
});

export const INTENT_SYSTEM = `You read one API endpoint's server code and report what it does.

Return ONLY a JSON object: { "intent": "...", "confidence": "low|medium|high", "clarification": null }.

Rules:
  - intent: one sentence, plain English, what a caller gets and when.
  - confidence: high if the code makes the behaviour clear; low if you are guessing.
  - clarification: a single concrete question ONLY when something material is
    genuinely ambiguous (an unclear required/optional parameter, an unclear
    success shape, an unclear auth requirement). Otherwise null. Do not invent
    questions to seem thorough.`;

function buildIntentPrompt({ endpoint, source }) {
  return [
    `Endpoint: ${endpoint.method} ${endpoint.path}`,
    endpoint.params?.length ? `Path parameters: ${endpoint.params.join(', ')}` : 'Path parameters: none',
    '',
    'Handler and related source (may be truncated):',
    '```',
    String(source ?? '').slice(0, 6000),
    '```',
  ].join('\n');
}

/**
 * Infers intent for one endpoint. `source` is the handler code slice.
 *
 * @returns {{ intent, confidence, clarification, provider, model, costUsd }}
 */
export async function inferEndpointIntent({ endpoint, source, llm = generateJSON }) {
  const result = await llm({
    system: INTENT_SYSTEM,
    prompt: buildIntentPrompt({ endpoint, source }),
    schema: intentSchema,
    task: TASK.EXPLANATION,
    maxRepairs: 1,
  });
  return {
    ...result.data,
    provider: result.provider,
    model: result.model,
    costUsd: result.costUsd,
  };
}

/**
 * True when an inferred intent should stop and ask the user before testing:
 * the model raised a concrete question, or it was not confident.
 */
export function needsClarification(intent) {
  return Boolean(intent?.clarification) || intent?.confidence === 'low';
}

export default inferEndpointIntent;
