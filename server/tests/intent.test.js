/**
 * Intent inference and the clarification trigger.
 *
 * The model is stubbed: what matters is that inferEndpointIntent grounds the
 * prompt in the endpoint and its source, and that needsClarification fires on a
 * concrete question or low confidence, which is what pauses to ask the user.
 */
import { describe, it, expect } from 'vitest';
import { inferEndpointIntent, needsClarification, intentSchema } from '../src/agents/intent.agent.js';

function stubLlm(payload, capture = {}) {
  return async ({ prompt, schema }) => {
    capture.prompt = prompt;
    return {
      data: schema.parse(payload), provider: 'stub', model: 'stub-1', costUsd: 0.0001,
    };
  };
}

describe('inferEndpointIntent', () => {
  it('grounds the prompt in the endpoint and its source', async () => {
    const capture = {};
    const out = await inferEndpointIntent({
      endpoint: { method: 'GET', path: '/users/:id', params: ['id'] },
      source: 'app.get("/users/:id", (req,res) => res.json(db.find(req.params.id)))',
      llm: stubLlm({ intent: 'Returns one user by id', confidence: 'high', clarification: null }, capture),
    });
    expect(capture.prompt).toContain('GET /users/:id');
    expect(capture.prompt).toContain('Path parameters: id');
    expect(capture.prompt).toContain('db.find');
    expect(out.intent).toBe('Returns one user by id');
    expect(out.confidence).toBe('high');
  });
});

describe('needsClarification', () => {
  it('is true when the model asks a concrete question', () => {
    expect(needsClarification({ confidence: 'high', clarification: 'Is patientId required?' })).toBe(true);
  });
  it('is true when confidence is low', () => {
    expect(needsClarification({ confidence: 'low', clarification: null })).toBe(true);
  });
  it('is false when confident and unambiguous', () => {
    expect(needsClarification({ confidence: 'high', clarification: null })).toBe(false);
  });
});

describe('intentSchema', () => {
  it('defaults clarification to null when omitted', () => {
    expect(intentSchema.parse({ intent: 'x', confidence: 'medium' }).clarification).toBeNull();
  });
});
