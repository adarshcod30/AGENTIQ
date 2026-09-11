/**
 * Assessment detail: the live phase timeline and the consolidated result.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §C, §F. The page polls while the assessment is
 * running (the hook stops polling at COMPLETE, FAILED or AWAITING_INPUT), so the
 * timeline advances on its own. When the run pauses for a clarification, the
 * question is answered here and the pipeline resumes.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, HelpCircle, CheckCircle2, AlertTriangle, UploadCloud, Download } from 'lucide-react';
import { useAssessment, useAnswerClarification, downloadAssessmentReport } from '@/hooks/api';
import { ProgressList, type ProgressStep, type StepState } from '@/components/ui/ProgressList';
import {
  Card, CardHeader, CardBody, Button, Field, Input, Alert, Chip, SeverityChip, Skeleton, EmptyState,
} from '@/components/ui';
import { AssessChip } from './ProjectsPage';
import type { Assessment, AssessState, Severity, Recommendation } from '@/types';

/** Priority styling for a recommendation: colour of the left rule and the chip. */
const PRIORITY: Record<number, { label: string; chip: string; rule: string }> = {
  1: { label: 'critical', chip: 'bg-danger-50 text-sev-critical', rule: 'border-l-sev-critical' },
  2: { label: 'high', chip: 'bg-danger-50 text-sev-high', rule: 'border-l-sev-high' },
  3: { label: 'medium', chip: 'bg-warning-50 text-sev-medium', rule: 'border-l-sev-medium' },
  4: { label: 'low', chip: 'bg-surface-3 text-sev-low', rule: 'border-l-sev-low' },
};

/** Where each state sits on the pipeline, so the timeline can be derived. */
const PROGRESS: Record<AssessState, number> = {
  PENDING: 0, DISCOVERING: 1, TESTING: 2, AWAITING_INPUT: 2,
  SCANNING: 3, ANALYZING: 4, REPORTING: 5, COMPLETE: 6, FAILED: -1,
};

const PHASES: { at: number; label: string }[] = [
  { at: 1, label: 'Discover the project' },
  { at: 2, label: 'Test endpoints' },
  { at: 3, label: 'Security scan' },
  { at: 4, label: 'Analyze and judge readiness' },
  { at: 5, label: 'Assemble the report' },
];

/** The furthest phase actually reached, used to place a FAILED marker. */
function reachedProgress(a: Assessment): number {
  const states = a.stateHistory.map((h) => h.state).filter((s) => s !== 'FAILED');
  return states.reduce((max, s) => Math.max(max, PROGRESS[s] ?? 0), 0);
}

function buildSteps(a: Assessment): ProgressStep[] {
  const failed = a.state === 'FAILED';
  const current = failed ? reachedProgress(a) : PROGRESS[a.state];
  return PHASES.map((p) => {
    let state: StepState;
    if (a.state === 'COMPLETE') state = 'done';
    else if (failed) state = p.at < current ? 'done' : p.at === current ? 'failed' : 'pending';
    else if (p.at < current) state = 'done';
    else if (p.at === current) state = 'active';
    else state = 'pending';

    let detail: string | undefined;
    if (p.at === 2 && current >= 2) detail = `${a.endpoints.length} endpoint(s)`;
    if (p.at === 3 && current >= 3) detail = `${a.security.findings.length} finding(s)`;
    if (p.at === 2 && a.state === 'AWAITING_INPUT') detail = 'waiting for a clarification';
    return { key: p.label, label: p.label, state, detail };
  });
}

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const isSeverity = (s: string): s is Severity => (SEVERITIES as string[]).includes(s);

export function AssessmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useAssessment(id);
  const answer = useAnswerClarification(id ?? '');
  const [answers, setAnswers] = useState<Record<string, string>>({});

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-64" /></div>;
  if (error || !data?.assessment) {
    return (
      <Card>
        <EmptyState title="Assessment not found"
          body="It may belong to another account, or the id is wrong." />
      </Card>
    );
  }

  const a = data.assessment;
  const pending = a.clarifications.filter((c) => !c.answer);

  return (
    <div className="max-w-4xl space-y-4">
      <Link to="/projects" className="t-small inline-flex items-center gap-1 text-ink-muted hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> Projects
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="t-h1">Assessment</h1>
        <AssessChip state={a.state} />
        {a.baseUrl && <span className="t-mono text-[12px] text-ink-muted">{a.baseUrl}</span>}
      </div>

      {a.error && <Alert tone="danger" title="The assessment failed">{a.error.message}</Alert>}

      <Card>
        <CardHeader title="Progress" />
        <CardBody><ProgressList steps={buildSteps(a)} /></CardBody>
      </Card>

      {a.state === 'AWAITING_INPUT' && pending.length > 0 && (
        <Card className="border-warning/40">
          <CardHeader title="A clarification is needed" />
          <CardBody className="space-y-4">
            <p className="t-small text-ink-muted">
              The intent of an endpoint was ambiguous. Answer and the assessment continues.
            </p>
            {pending.map((c) => (
              <div key={c.endpoint} className="space-y-2 rounded-[6px] border border-line p-3">
                <div className="flex items-center gap-2">
                  <HelpCircle size={15} className="text-warning" aria-hidden />
                  <span className="t-mono text-[12.5px]">{c.endpoint}</span>
                </div>
                <p className="t-small text-ink">{c.question}</p>
                <Field label="Your answer" htmlFor={`ans-${c.endpoint}`}>
                  <Input id={`ans-${c.endpoint}`} value={answers[c.endpoint] ?? ''}
                    onChange={(e) => setAnswers((v) => ({ ...v, [c.endpoint]: e.target.value }))} />
                </Field>
                <Button size="sm" loading={answer.isPending}
                  disabled={!(answers[c.endpoint] ?? '').trim()}
                  onClick={() => answer.mutate({ endpoint: c.endpoint, answer: answers[c.endpoint] })}>
                  Submit and resume
                </Button>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Readiness" />
        <CardBody className="space-y-3">
          <div className="flex items-center gap-2">
            {a.readiness.ready
              ? <CheckCircle2 size={18} className="text-success" aria-hidden />
              : <AlertTriangle size={18} className="text-warning" aria-hidden />}
            <span className="text-[13px] font-medium text-ink">
              {a.readiness.ready ? 'Ready to deploy' : 'Not ready to deploy'}
            </span>
          </div>
          {a.readiness.blockers.length > 0 && (
            <div>
              <p className="t-label mb-1">Blockers</p>
              <ul className="t-small list-disc space-y-0.5 pl-5 text-danger">
                {a.readiness.blockers.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          )}
          {a.readiness.warnings.length > 0 && (
            <div>
              <p className="t-label mb-1">Warnings</p>
              <ul className="t-small list-disc space-y-0.5 pl-5 text-ink-muted">
                {a.readiness.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>

      {a.report && a.report.recommendations.length > 0 && (
        <Card>
          <CardHeader
            title="Recommendations"
            actions={(
              <div className="flex items-center gap-1.5">
                {(['critical', 'high', 'medium', 'low'] as const).map((k) => {
                  const n = a.report!.recommendationSummary.byPriority[k] ?? 0;
                  return n > 0 ? <Chip key={k} className={PRIORITY[({ critical: 1, high: 2, medium: 3, low: 4 })[k]].chip}>{n} {k}</Chip> : null;
                })}
              </div>
            )}
          />
          <CardBody className="space-y-3">
            <p className="t-small text-ink-muted">
              What to fix, why it matters, and how, in priority order. The engine derives each from the
              stage that produced it.
            </p>
            {a.report.recommendations.map((r) => <RecRow key={r.id} rec={r} />)}
          </CardBody>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader title={`Endpoints (${a.endpoints.length})`} />
        {a.endpoints.length === 0 ? (
          <CardBody><p className="t-small text-ink-muted">No endpoints were tested.</p></CardBody>
        ) : (
          <div className="divide-y divide-line">
            {a.endpoints.map((e, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="t-mono w-16 shrink-0 text-[12px] font-medium">{e.method}</span>
                <span className="t-mono min-w-0 flex-1 truncate text-[12.5px]">{e.path}</span>
                {e.intent && <span className="t-small hidden text-ink-subtle sm:inline">{e.intent}</span>}
                <span className="t-small text-ink-muted">
                  {e.status === 'complete' ? `${e.passed} passed, ${e.failed} failed` : e.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={`Security findings (${a.security.findings.length})`} />
        <CardBody className="space-y-3">
          {a.security.findings.length === 0 && (
            <p className="t-small text-ink-muted">No findings were raised.</p>
          )}
          {a.security.findings.map((f, i) => (
            <div key={i} className="space-y-1 rounded-[6px] border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                {isSeverity(f.severity)
                  ? <SeverityChip severity={f.severity} />
                  : <Chip className="bg-surface-3 text-ink-muted">{f.severity.toUpperCase()}</Chip>}
                <span className="text-[13px] font-medium text-ink">{f.title}</span>
                <Chip className="bg-surface-3 text-ink-subtle">{f.confidence}</Chip>
                {f.owasp && <Chip className="bg-surface-3 text-ink-subtle">{f.owasp}</Chip>}
              </div>
              {f.description && <p className="t-small text-ink-muted">{f.description}</p>}
              {f.remediation && <p className="t-small text-ink">Fix: {f.remediation}</p>}
            </div>
          ))}
          {a.security.notes.length > 0 && (
            <Alert tone="info">{a.security.notes.join(' ')}</Alert>
          )}
        </CardBody>
      </Card>

      {a.report && (
        <Card>
          <CardHeader
            title="Consolidated report"
            actions={(
              <Button size="sm" variant="secondary" onClick={() => { void downloadAssessmentReport(a._id); }}>
                <Download size={14} aria-hidden /> Download
              </Button>
            )}
          />
          <CardBody className="space-y-4">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
              <span><span className="t-label">Framework</span> {a.report.project.framework}</span>
              <span><span className="t-label">Endpoints</span> {a.report.project.endpointCount}</span>
              <span><span className="t-label">Dependencies</span> {a.report.project.dependencyCount}</span>
              <span><span className="t-label">Tested</span> {a.report.testing.endpointsTested} (skipped {a.report.testing.endpointsSkipped})</span>
            </div>

            {a.report.discoveredApis.length > 0 && (
              <div className="overflow-x-auto rounded-[6px] border border-line">
                <table className="w-full text-[12.5px]">
                  <thead className="bg-surface-2 text-ink-muted">
                    <tr><th className="px-3 py-1.5 text-left">Method</th><th className="px-3 py-1.5 text-left">Path</th><th className="px-3 py-1.5 text-left">Intent</th></tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {a.report.discoveredApis.map((e, i) => (
                      <tr key={i}>
                        <td className="t-mono px-3 py-1.5">{e.method}</td>
                        <td className="t-mono px-3 py-1.5">{e.path}</td>
                        <td className="px-3 py-1.5 text-ink-muted">{e.intent ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {a.report.testing.endpointsWithFailures.length > 0 && (
              <div>
                <p className="t-label mb-1">Endpoints with failures</p>
                <ul className="t-small list-disc space-y-0.5 pl-5 text-ink-muted">
                  {a.report.testing.endpointsWithFailures.map((e, i) => <li key={i} className="t-mono">{e}</li>)}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <span className="t-small text-ink-muted">
                {a.readiness.ready
                  ? 'This project passed the readiness checks.'
                  : 'Resolve the blockers above before deploying.'}
              </span>
              <Link to="/deploy"
                className="t-small inline-flex items-center gap-1.5 rounded-[6px] bg-primary px-3 py-1.5 font-medium text-white hover:opacity-90">
                <UploadCloud size={15} aria-hidden /> Deploy this project
              </Link>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/** One recommendation: what, why, how, and tips, colour-coded by priority. */
function RecRow({ rec }: { rec: Recommendation }) {
  const p = PRIORITY[rec.priority] ?? PRIORITY[4];
  return (
    <div className={`space-y-1.5 rounded-[6px] border border-line border-l-[3px] ${p.rule} bg-surface-2 p-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip className={p.chip}>{p.label}</Chip>
        <Chip className="bg-surface-3 text-ink-subtle">{rec.stage}</Chip>
        <span className="text-[13px] font-semibold text-ink">{rec.title}</span>
      </div>
      <p className="t-small text-ink-muted"><span className="font-semibold text-ink">Why: </span>{rec.why}</p>
      <p className="t-small"><span className="font-semibold text-ink">Fix: </span><span className="text-ink-muted">{rec.fix}</span></p>
      {rec.where && rec.where.length > 0 && (
        <p className="t-small text-ink-subtle">
          <span className="font-semibold text-ink">Affects: </span>
          <span className="t-mono">{rec.where.join(', ')}</span>
        </p>
      )}
      {rec.tips.length > 0 && (
        <div className="pt-0.5">
          <p className="t-label mb-0.5">Tips</p>
          <ul className="t-small list-disc space-y-0.5 pl-5 text-ink-muted">
            {rec.tips.map((tip, i) => <li key={i}>{tip}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
