/**
 * The run progress list.
 *
 * docs/04_App_UI.md §6: "One row per step: state icon, label, elapsed (mono,
 * tabular), result summary. Completed rows stay visible. This replaces every
 * full-page spinner in the app."
 *
 * Elapsed time is REAL. docs/04_App_UI.md §10 forbids "fake progress bars that
 * animate independently of real work": a bar that fills while nothing happens
 * is a lie the user can feel, and it is the first thing that makes an interface
 * feel untrustworthy.
 */
import { Check, X, Circle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export type StepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface ProgressStep {
  key: string;
  label: string;
  state: StepState;
  /** Real elapsed milliseconds. Never a synthetic estimate. */
  elapsedMs?: number;
  /** e.g. "3 passed · 1 failed" or "llama-3.1-8b-instant, 1,240 tok" */
  detail?: string;
}

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case 'done':
      return <Check size={16} className="text-success" aria-hidden />;
    case 'failed':
      return <X size={16} className="text-danger" aria-hidden />;
    case 'active':
      // The one sanctioned inline spinner (docs/04_App_UI.md §4).
      return <Loader2 size={16} className="animate-spin text-accent" aria-hidden />;
    case 'skipped':
      return <Circle size={16} className="text-ink-subtle" aria-hidden />;
    default:
      return <Circle size={16} className="text-line" aria-hidden />;
  }
}

const STATE_LABEL: Record<StepState, string> = {
  pending: 'not started', active: 'in progress', done: 'complete',
  failed: 'failed', skipped: 'skipped',
};

function formatElapsed(ms?: number) {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ProgressList({ steps }: { steps: ProgressStep[] }) {
  return (
    // Screen readers hear steps complete as they land (docs/04_App_UI.md §8).
    <ol className="divide-y divide-line" aria-live="polite" aria-label="Run progress">
      {steps.map((step) => (
        <li
          key={step.key}
          className={cn(
            'flex items-center gap-3 px-4 py-2.5',
            step.state === 'pending' && 'opacity-55',
          )}
        >
          <StepIcon state={step.state} />

          <span className="min-w-0 flex-1 text-[13px] text-ink">
            {step.label}
            <span className="sr-only">: {STATE_LABEL[step.state]}</span>
          </span>

          {step.detail && (
            <span className="t-small hidden text-ink-muted sm:block">{step.detail}</span>
          )}

          <span className="t-mono w-14 shrink-0 text-right text-ink-muted" data-numeric>
            {formatElapsed(step.elapsedMs)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Maps a run's persisted state history onto the five display steps.
 *
 * Derived from real state, never from a timer. A run that reached GEN_FAILED
 * shows generation FAILED and everything after it skipped, not a bar frozen
 * at 40%.
 */
export function stepsFromRun(run: {
  state: string;
  stateHistory?: { state: string; at: string }[];
  summary?: { totalTests: number; passed: number; failed: number; discarded: number };
  generation?: { model?: string; inputTokens: number; outputTokens: number; generationMs?: number };
  security?: unknown[];
}): ProgressStep[] {
  const history = run.stateHistory ?? [];
  const reached = (s: string) => history.some((h) => h.state === s);

  const elapsedFor = (from: string, to: string) => {
    const a = history.find((h) => h.state === from);
    const b = history.find((h) => h.state === to);
    if (!a || !b) return undefined;
    return new Date(b.at).getTime() - new Date(a.at).getTime();
  };

  const genFailed = run.state === 'GEN_FAILED';
  const execFailed = run.state === 'EXEC_FAILED';
  const cancelled = run.state === 'CANCELLED';

  const tokens = run.generation
    ? (run.generation.inputTokens ?? 0) + (run.generation.outputTokens ?? 0)
    : 0;

  return [
    {
      key: 'grant',
      label: 'Awaiting permission',
      state: cancelled ? 'failed' : reached('GENERATING') ? 'done' : 'active',
      elapsedMs: elapsedFor('AWAITING_GRANT', 'GENERATING'),
    },
    {
      key: 'generate',
      label: 'Generating test cases',
      state: genFailed ? 'failed'
        : reached('EXECUTING') ? 'done'
          : reached('GENERATING') ? 'active' : 'pending',
      elapsedMs: run.generation?.generationMs ?? elapsedFor('GENERATING', 'EXECUTING'),
      detail: run.generation?.model
        ? `${run.generation.model}${tokens ? `, ${tokens.toLocaleString()} tok` : ''}`
        : undefined,
    },
    {
      key: 'execute',
      label: run.summary?.totalTests
        ? `Executing ${run.summary.totalTests} case${run.summary.totalTests === 1 ? '' : 's'}`
        : 'Executing cases',
      state: execFailed ? 'failed'
        : genFailed || cancelled ? 'skipped'
          : reached('EXPLAINING') || run.state === 'COMPLETE' ? 'done'
            : reached('EXECUTING') ? 'active' : 'pending',
      elapsedMs: elapsedFor('EXECUTING', reached('EXPLAINING') ? 'EXPLAINING' : 'COMPLETE'),
      detail: run.summary
        ? `${run.summary.passed} passed · ${run.summary.failed} failed`
          + (run.summary.discarded ? ` · ${run.summary.discarded} discarded` : '')
        : undefined,
    },
    {
      key: 'scan',
      label: 'Security scan',
      state: run.security?.length ? 'done' : 'skipped',
      detail: run.security?.length ? `${run.security.length} finding(s)` : 'not requested',
    },
    {
      key: 'explain',
      label: 'Explaining failures',
      state: reached('EXPLAINING')
        ? (run.state === 'COMPLETE' ? 'done' : 'active')
        : 'skipped',
      elapsedMs: elapsedFor('EXPLAINING', 'COMPLETE'),
    },
  ];
}
