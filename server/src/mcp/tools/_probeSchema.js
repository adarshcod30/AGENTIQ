/**
 * Input and output schemas shared by every probe tool.
 *
 * All five probes describe their target the same way and report findings in
 * the same shape, so the Security Agent and the UI handle every family through
 * one code path. A finding carries the payload that was sent, the signal that
 * fired and the baseline it deviated from: a finding without evidence is not a
 * finding.
 */
import { z } from 'zod';

/** Every probe takes the same target description. */
export const probeInputSchema = z.object({
  url: z.url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /**
   * The user's declaration that this endpoint is meant to be reachable
   * anonymously. An anonymous 200 from a public endpoint is CORRECT behaviour;
   * without this flag the auth probe would report every public API as
   * vulnerable.
   */
  intendedPublic: z.boolean().default(false),
});

export const findingSchema = z.object({
  family: z.string(),
  owasp: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  vulnerable: z.boolean(),
  payload: z.string().nullable(),
  signal: z.string().nullable(),
  baseline: z.string().nullable(),
  explanation: z.string(),
  remediation: z.string(),
});

export const probeOutputSchema = z.object({
  family: z.string(),
  owasp: z.string(),
  findings: z.array(findingSchema),
});
