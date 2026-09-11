/**
 * Audit Log: docs/03_App_Flow.md B6.
 *
 * "Reverse-chronological invocations: timestamp, tool, risk class, target host,
 * outcome chip, duration. Filter by run, tool, outcome. `blocked_ssrf` and
 * `denied` rows render in the danger tone: THOSE ROWS ARE THE MOST PERSUASIVE
 * THING IN THE ENTIRE APP, because they prove the guard fires."
 *
 * A row here is not a log line. It is evidence that a specific action was
 * checked, and either allowed or refused, with a reason.
 */
import { useState } from 'react';
import { ScrollText, AlertTriangle } from 'lucide-react';
import { useAudit } from '@/hooks/api';
import {
  Card, Chip, RiskChip, SkeletonRows, EmptyState, Button, Alert,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import type { AuditOutcome } from '@/types';

const OUTCOMES: { value: string; label: string }[] = [
  { value: '', label: 'All outcomes' },
  { value: 'ok', label: 'ok' },
  { value: 'denied', label: 'denied' },
  { value: 'blocked_ssrf', label: 'blocked_ssrf' },
  { value: 'rate_limited', label: 'rate_limited' },
  { value: 'error', label: 'error' },
];

/** Refusals are visually distinct because they are the point. */
const OUTCOME_STYLE: Record<AuditOutcome, string> = {
  ok: 'bg-success-50 text-success',
  denied: 'bg-danger-50 text-danger',
  blocked_ssrf: 'bg-danger-50 text-danger',
  rate_limited: 'bg-warning-50 text-warning',
  error: 'bg-warning-50 text-warning',
};

const isRefusal = (o: AuditOutcome) => o === 'denied' || o === 'blocked_ssrf';

export function AuditLogPage() {
  const [outcome, setOutcome] = useState('');
  const { data, isLoading, isError, error, refetch } = useAudit(
    outcome ? { outcome } : {},
  );

  const events = data?.events ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-h1">Audit Log</h1>
          <p className="t-small mt-1 text-ink-muted">
            Every tool invocation, including the ones that were refused.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {OUTCOMES.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setOutcome(o.value)}
              className={cn(
                't-mono rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors',
                outcome === o.value
                  ? 'bg-primary text-white'
                  : 'bg-surface-3 text-ink-muted hover:text-ink',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <Alert tone="info">
        The collection is append-only. There is no update or delete route
        anywhere in the API: a recorded invocation cannot later be changed.
      </Alert>

      {isLoading && <Card className="p-4"><SkeletonRows rows={8} /></Card>}

      {isError && (
        <Card>
          <EmptyState
            icon={<AlertTriangle size={40} strokeWidth={1.5} />}
            title="Couldn't load the audit log"
            body={error instanceof Error ? error.message : 'Something went wrong.'}
            action={<Button size="sm" onClick={() => refetch()}>Retry</Button>}
          />
        </Card>
      )}

      {!isLoading && !isError && events.length === 0 && (
        <Card>
          <EmptyState
            icon={<ScrollText size={40} strokeWidth={1.5} />}
            title={outcome ? `No ${outcome} events` : 'No tool invocations yet'}
            body={
              outcome
                ? 'Nothing matched this filter. Try another outcome.'
                : 'Start a test run and every tool call the agents make will appear here.'
            }
          />
        </Card>
      )}

      {events.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left">
              <thead className="bg-surface-3">
                <tr className="t-label">
                  <th className="px-4 py-2 font-semibold">Time</th>
                  <th className="px-4 py-2 font-semibold">Tool</th>
                  <th className="px-4 py-2 font-semibold">Risk class</th>
                  <th className="px-4 py-2 font-semibold">Target host</th>
                  <th className="px-4 py-2 font-semibold">Outcome</th>
                  <th className="px-4 py-2 text-right font-semibold">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.map((e) => (
                  <tr
                    key={e._id}
                    className={cn(
                      'h-10 hover:bg-surface-2',
                      // The danger left rule. These rows are the proof.
                      isRefusal(e.outcome) && 'border-l-[3px] border-l-danger bg-danger-50/40',
                    )}
                  >
                    <td className="t-mono px-4 text-[12px] text-ink-muted" data-numeric>
                      {new Date(e.ts).toLocaleTimeString()}
                    </td>
                    <td className="t-mono px-4 text-[12.5px] text-ink">{e.tool}</td>
                    <td className="px-4"><RiskChip riskClass={e.riskClass} /></td>
                    <td className="t-mono px-4 text-[12.5px] text-ink-muted">
                      {e.targetHost ?? 'n/a'}
                    </td>
                    <td className="px-4">
                      <Chip className={OUTCOME_STYLE[e.outcome]}>{e.outcome}</Chip>
                    </td>
                    <td className="t-mono px-4 text-right text-[12.5px] text-ink-muted" data-numeric>
                      {e.durationMs}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* The reason a refusal happened, spelled out under the table. */}
          {events.some((e) => isRefusal(e.outcome) && e.reason) && (
            <div className="space-y-1.5 border-t border-line bg-surface-2 px-4 py-3">
              <div className="t-label">Why those requests were refused</div>
              {events.filter((e) => isRefusal(e.outcome) && e.reason).slice(0, 4).map((e) => (
                <p key={e._id} className="t-small text-ink">
                  <span className="t-mono text-danger">{e.outcome}</span>{' '}
                  <span className="text-ink-muted">{e.reason}</span>
                </p>
              ))}
            </div>
          )}
        </Card>
      )}

      {data && (
        <p className="t-small text-ink-subtle">
          Showing {events.length} of {data.total} events.
        </p>
      )}
    </div>
  );
}
