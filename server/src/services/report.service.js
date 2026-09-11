/**
 * The consolidated report: readiness verdict and the structured report object.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §9 Phase 5. computeReadiness turns the run's
 * results into a deployment-readiness verdict; buildReport assembles the single
 * document a user reads. Rendering that object to Markdown is the report_render
 * tool; keeping the DATA here means the verdict is computed once and testable
 * without any formatting.
 */
import { buildRecommendations, summariseRecommendations, PRIORITY_LABEL } from './guidance.js';

const isBlockingSeverity = (s) => s === 'critical' || s === 'high';

/**
 * The deployment-readiness verdict.
 *
 * Blockers stop a deploy: a high or critical security finding, an endpoint whose
 * tests failed, or an app that could not be started when there were endpoints to
 * test. Warnings are worth fixing but do not block. Ready means no blockers.
 */
export function computeReadiness(assessment) {
  const blockers = [];
  const warnings = [];

  for (const f of assessment.security?.findings ?? []) {
    if (isBlockingSeverity(f.severity)) {
      blockers.push(`${f.severity.toUpperCase()} ${f.category}: ${f.title}`);
    } else if (f.severity === 'medium') {
      warnings.push(`${f.category}: ${f.title}`);
    }
  }

  const tested = (assessment.endpoints ?? []).filter((e) => e.status === 'complete');
  const withFailures = tested.filter((e) => (e.failed ?? 0) > 0);
  for (const e of withFailures) {
    blockers.push(`${e.method} ${e.path}: ${e.failed} test(s) failed`);
  }
  const skipped = (assessment.endpoints ?? []).filter((e) => e.status === 'skipped');
  if (skipped.length && !assessment.baseUrl) {
    warnings.push(`${skipped.length} endpoint(s) not tested: the app was not started.`);
  }
  const unresolved = (assessment.clarifications ?? []).filter((c) => !c.answer);
  if (unresolved.length) warnings.push(`${unresolved.length} open clarification question(s).`);

  return { ready: blockers.length === 0, blockers, warnings };
}

/** Assembles the structured consolidated report. */
export function buildReport(assessment, model) {
  const endpoints = assessment.endpoints ?? [];
  const tested = endpoints.filter((e) => e.status === 'complete');
  const passed = tested.reduce((n, e) => n + (e.passed ?? 0), 0);
  const failed = tested.reduce((n, e) => n + (e.failed ?? 0), 0);
  const findings = assessment.security?.findings ?? [];
  const recommendations = buildRecommendations({ assessment, model });

  return {
    generatedAt: new Date().toISOString(),
    project: {
      framework: model?.framework ?? 'unknown',
      endpointCount: model?.endpointCount ?? endpoints.length,
      dependencyCount: (model?.dependencies ?? []).length,
    },
    discoveredApis: endpoints.map((e) => ({ method: e.method, path: e.path, intent: e.intent, confidence: e.confidence })),
    testing: {
      endpointsTested: tested.length,
      endpointsSkipped: endpoints.filter((e) => e.status === 'skipped').length,
      assertionsPassed: passed,
      assertionsFailed: failed,
      endpointsWithFailures: tested.filter((e) => (e.failed ?? 0) > 0).map((e) => `${e.method} ${e.path}`),
    },
    security: {
      total: findings.length,
      bySeverity: assessment.security?.summary?.bySeverity ?? {},
      findings: findings.map((f) => ({
        severity: f.severity, confidence: f.confidence, category: f.category,
        title: f.title, evidence: f.evidence, remediation: f.remediation,
        location: f.location,
      })),
      notes: assessment.security?.notes ?? [],
    },
    readiness: assessment.readiness ?? { ready: false, blockers: [], warnings: [] },
    clarifications: (assessment.clarifications ?? []).map((c) => ({ endpoint: c.endpoint, question: c.question, answer: c.answer })),
    // The advisory layer: why each issue happened and how to fix it, prioritised.
    recommendations,
    recommendationSummary: summariseRecommendations(recommendations),
  };
}

/** Renders the structured report object to Markdown (report_render uses this). */
export function renderReportMarkdown(report) {
  const L = [];
  const w = (...lines) => L.push(...lines);
  const r = report.readiness ?? {};

  w(`# Assessment report`, '', `Generated ${report.generatedAt}`, '');
  w(`## Readiness: ${r.ready ? 'READY' : 'NOT READY'}`, '');
  if (r.blockers?.length) w('**Blockers:**', ...r.blockers.map((b) => `- ${b}`), '');
  if (r.warnings?.length) w('**Warnings:**', ...r.warnings.map((x) => `- ${x}`), '');

  const recs = report.recommendations ?? [];
  if (recs.length) {
    w('## Recommendations', '', 'What to fix, why it matters, and how, in priority order.', '');
    for (const rec of recs) {
      w(`### [${PRIORITY_LABEL[rec.priority] ?? rec.priority}] ${rec.stage}: ${rec.title}`,
        `- Why: ${rec.why}`,
        `- Fix: ${rec.fix}`,
        ...(rec.where?.length ? [`- Where: ${rec.where.join(', ')}`] : []),
        ...(rec.tips?.length ? ['- Tips:', ...rec.tips.map((tip) => `  - ${tip}`)] : []),
        '');
    }
  }

  w('## Project', '',
    `- Framework: ${report.project.framework}`,
    `- Endpoints discovered: ${report.project.endpointCount}`,
    `- Dependencies: ${report.project.dependencyCount}`, '');

  w('## Discovered APIs', '');
  if (report.discoveredApis.length) {
    w('| Method | Path | Inferred intent |', '| --- | --- | --- |',
      ...report.discoveredApis.map((e) => `| ${e.method} | ${e.path} | ${e.intent ?? ''} |`), '');
  } else {
    w('None discovered.', '');
  }

  const t = report.testing;
  w('## Testing', '',
    `- Endpoints tested: ${t.endpointsTested} (skipped ${t.endpointsSkipped})`,
    `- Assertions passed: ${t.assertionsPassed}, failed: ${t.assertionsFailed}`, '');
  if (t.endpointsWithFailures.length) w('Endpoints with failures:', ...t.endpointsWithFailures.map((e) => `- ${e}`), '');

  w('## Security', '', `${report.security.total} finding(s).`, '');
  for (const f of report.security.findings) {
    w(`### [${f.severity}] ${f.title}`,
      `- Category: ${f.category} (confidence: ${f.confidence})`,
      f.location?.file ? `- Location: ${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : (f.location?.endpoint ? `- Endpoint: ${f.location.endpoint}` : ''),
      f.evidence ? `- Evidence: ${f.evidence}` : '',
      f.remediation ? `- Fix: ${f.remediation}` : '', '');
  }
  for (const n of report.security.notes) w(`> ${n}`);
  w('', '_This is not a guarantee of security. Static and dynamic checks cover common issues, not all of them._');

  return L.filter((line) => line !== undefined).join('\n');
}
