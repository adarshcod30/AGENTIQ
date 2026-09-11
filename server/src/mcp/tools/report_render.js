/**
 * report_render: render the structured assessment report to Markdown.
 * docs/10_AUTONOMOUS_PLATFORM.md §E, Phase 5. Pure (local.compute): the report
 * object is assembled by the orchestrator (report.service.js); this turns it
 * into the document a person reads.
 */
import { z } from 'zod';
import { defineTool } from '../registry.js';
import { RISK_CLASS } from '../permissions.js';
import { renderReportMarkdown } from '../../services/report.service.js';

export const inputSchema = z.object({
  report: z.record(z.string(), z.unknown()),
});

export const outputSchema = z.object({
  markdown: z.string(),
  bytes: z.number(),
});

export default defineTool({
  name: 'report_render',
  title: 'Render the assessment report',
  description: 'Render the structured assessment report object to Markdown.',
  riskClass: RISK_CLASS.LOCAL_COMPUTE,
  inputSchema,
  outputSchema,
  async handler(input) {
    const markdown = renderReportMarkdown(input.report);
    return { markdown, bytes: Buffer.byteLength(markdown) };
  },
});
