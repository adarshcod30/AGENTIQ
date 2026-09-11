/**
 * The Zod schema for the shared security finding (analysis/findings.js).
 * Used by every static-analysis tool's outputSchema so the registry publishes
 * one finding shape for the whole security surface.
 */
import { z } from 'zod';

export const findingSchema = z.object({
  lane: z.string(),
  category: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  confidence: z.enum(['confirmed', 'strong', 'potential', 'informational']),
  title: z.string(),
  description: z.string(),
  evidence: z.string(),
  remediation: z.string(),
  owasp: z.string().nullable(),
  location: z.object({
    file: z.string().nullable(),
    line: z.number().nullable(),
    endpoint: z.string().nullable(),
  }),
});

export default findingSchema;
