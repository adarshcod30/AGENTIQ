/**
 * Run results: the summary strip and the Functional / Security tabs.
 *
 * docs/03_App_Flow.md B2. Shared by the Test Runner and the Run detail page,
 * so a result looks identical wherever you meet it.
 */
import { useState } from 'react';
import { ShieldCheck, FileText } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  Card, CardBody, StatusChip, MethodChip, Chip, AssertionRow, FindingCard, Alert, EmptyState,
} from '@/components/ui';
import type { TestRun } from '@/types';

export function RunResults({ run }: { run: TestRun }) {
  const [tab, setTab] = useState<'functional' | 'security'>('functional');
  const s = run.summary;

  return (
    <div className="space-y-4">
      {/* Summary strip: docs/03_App_Flow.md B2. Every number is real. */}
      <Card>
        <CardBody className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
          <Stat value={s.totalTests} label="tests" />
          <Stat value={s.passed} label="passed" tone="success" />
          <Stat value={s.failed} label="failed" tone={s.failed > 0 ? 'danger' : undefined} />
          {/* Discarded is SURFACED, not hidden (docs/01_PRD.md F2). */}
          <Stat value={s.discarded} label="discarded" tone={s.discarded > 0 ? 'warning' : undefined} />
          <Stat value={run.security?.length ?? 0} label="findings" />
          {run.durationMs !== null && (
            <Stat value={`${(run.durationMs / 1000).toFixed(1)}s`} label="elapsed" />
          )}
          {run.generation?.inputTokens ? (
            <Stat
              value={(run.generation.inputTokens + run.generation.outputTokens).toLocaleString()}
              label="tokens"
            />
          ) : null}
          {run.grounded && (
            <Chip className="bg-info-50 text-info">Grounded by specification</Chip>
          )}
        </CardBody>
      </Card>

      <div className="flex gap-1 border-b border-line">
        <Tab active={tab === 'functional'} onClick={() => setTab('functional')}
          icon={<FileText size={14} aria-hidden />}
          label={`Functional (${run.functional?.length ?? 0})`} />
        <Tab active={tab === 'security'} onClick={() => setTab('security')}
          icon={<ShieldCheck size={14} aria-hidden />}
          label={`Security (${run.security?.length ?? 0})`} />
      </div>

      {tab === 'functional' && <FunctionalTab run={run} />}
      {tab === 'security' && <SecurityTab run={run} />}
    </div>
  );
}

function Stat({ value, label, tone }: {
  value: string | number; label: string; tone?: 'success' | 'danger' | 'warning';
}) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span
        className={cn(
          'text-[15px] font-semibold tabular',
          tone === 'success' && 'text-success',
          tone === 'danger' && 'text-danger',
          tone === 'warning' && 'text-warning',
        )}
        data-numeric
      >
        {value}
      </span>
      <span className="text-ink-muted">{label}</span>
    </span>
  );
}

function Tab({ active, onClick, icon, label }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-ink-muted hover:text-ink',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {icon}{label}
    </button>
  );
}

function FunctionalTab({ run }: { run: TestRun }) {
  if (!run.functional?.length) {
    return (
      <Card>
        <EmptyState
          title="No functional results"
          body={
            run.state === 'GEN_FAILED'
              ? 'Generation failed, so no cases were executed. Nothing was fabricated to fill this space.'
              : 'This run produced no executed cases.'
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {run.functional.map((result, i) => (
        <details
          key={i}
          // A failing case is never collapsed by default (docs/04_App_UI.md §6).
          open={result.status !== 'pass'}
          className="card overflow-hidden"
        >
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 p-4">
            <StatusChip status={result.status} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
              {result.name}
            </span>
            {result.category && (
              <Chip className="bg-surface-3 text-ink-muted">{result.category}</Chip>
            )}
            <span className="t-mono text-[12px] text-ink-muted" data-numeric>
              {result.responseTimeMs}ms
            </span>
          </summary>

          <div className="border-t border-line">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <MethodChip method={run.target.method} />
              <span className="t-mono min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">
                {run.target.url}
              </span>
              {result.httpStatus !== null && (
                <Chip className="bg-surface-3 text-ink-muted">HTTP {result.httpStatus}</Chip>
              )}
            </div>

            {result.intent && (
              <p className="t-small border-t border-line px-4 py-2 text-ink-muted">
                <span className="t-label mr-2">Intent</span>{result.intent}
              </p>
            )}

            <div className="border-t border-line">
              <div className="t-label px-4 pb-1 pt-2.5">Assertions</div>
              <div className="divide-y divide-line">
                {result.assertions.map((a, j) => <AssertionRow key={j} assertion={a} />)}
              </div>
            </div>

            {result.error && (
              <div className="border-t border-line px-4 py-3">
                <Alert tone="warning" title="Request failed">{result.error}</Alert>
              </div>
            )}

            {result.explanation && (
              <div className="border-t border-line bg-surface-2 px-4 py-3">
                <div className="t-label mb-1">Why this failed</div>
                <p className="text-[13px] leading-relaxed text-ink">{result.explanation}</p>
              </div>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function SecurityTab({ run }: { run: TestRun }) {
  const findings = run.security ?? [];

  if (findings.length === 0) {
    /**
     * The clean result is a DESIGNED state, not an empty list
     * (docs/03_App_Flow.md B2), and it carries the honest disclosure.
     */
    return (
      <Card className="border-success/30 bg-success-50">
        <CardBody className="flex gap-3">
          <ShieldCheck size={20} className="mt-0.5 shrink-0 text-success" aria-hidden />
          <div>
            <h3 className="t-h3">No indicators found</h3>
            <p className="t-small mt-1 text-ink">
              This is not a guarantee of security. See{' '}
              <a href="/about" className="font-medium text-accent hover:underline">About</a>{' '}
              for what is and is not covered.
            </p>
          </div>
        </CardBody>
      </Card>
    );
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);

  return (
    <div className="space-y-2">
      {sorted.map((f, i) => <FindingCard key={i} finding={f} defaultOpen={i === 0} />)}
    </div>
  );
}
