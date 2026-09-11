/**
 * http_request: execute one arbitrary HTTP request.
 *
 * docs/01_PRD.md F1. The workhorse: every other network tool is built on it,
 * and it reaches the network ONLY through fetchGuarded, so the SSRF controls
 * apply to everything by construction rather than by remembering.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { fetchGuarded } from '../egress.js';

export const inputSchema = z.object({
  url: z.url({ error: 'A full http(s) URL is required' }),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  timeoutMs: z.number().int().positive().max(30_000).optional(),
});

export const outputSchema = z.object({
  status: z.number(),
  headers: z.record(z.string(), z.unknown()),
  body: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
  durationMs: z.number(),
  ip: z.string(),
  url: z.string(),
  redirects: z.array(z.object({ url: z.string(), ip: z.string(), status: z.number() })),
});

export default defineTool({
  name: 'http_request',
  title: 'HTTP request',
  description:
    'Execute a single HTTP request against a user-nominated host and return the status, ' +
    'headers, body and timing. All traffic passes through the SSRF egress guard.',
  riskClass: RISK_CLASS.NETWORK_READ,
  inputSchema,
  outputSchema,
  async handler(input) {
    const res = await fetchGuarded(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
    return {
      status: res.status,
      headers: res.headers,
      body: res.body,
      bytes: res.bytes,
      truncated: res.truncated,
      durationMs: res.durationMs,
      ip: res.ip,
      url: res.url,
      redirects: res.redirects,
    };
  },
});
