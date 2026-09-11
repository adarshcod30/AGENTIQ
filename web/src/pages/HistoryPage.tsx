/**
 * History: docs/04_App_UI.md §7. Filterable table, row-click to detail.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { History, AlertTriangle } from 'lucide-react';
import { useRuns } from '@/hooks/api';
import { Card, MethodChip, Chip, StatusChip, SkeletonRows, EmptyState, Button, Input } from '@/components/ui';
import type { TestRun } from '@/types';

export function HistoryPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading, isError, refetch } = useRuns();

  const runs = (data?.runs ?? []).filter((r) =>
    !search || r.target.url.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="t-h1">History</h1>
          <p className="t-small mt-1 text-ink-muted">Every run, including the ones that failed.</p>
        </div>
        <Input
          placeholder="Filter by URL" value={search} mono
          onChange={(e) => setSearch(e.target.value)} className="max-w-64"
        />
      </div>

      {isLoading && <Card className="p-4"><SkeletonRows rows={6} /></Card>}

      {isError && (
        <Card>
          <EmptyState
            icon={<AlertTriangle size={40} strokeWidth={1.5} />}
            title="Couldn't load history" body="Something went wrong."
            action={<Button size="sm" onClick={() => refetch()}>Retry</Button>}
          />
        </Card>
      )}

      {!isLoading && !isError && runs.length === 0 && (
        <Card>
          <EmptyState
            icon={<History size={40} strokeWidth={1.5} />}
            title={search ? 'No matching runs' : 'No runs yet'}
            body={search ? 'Try a different filter.' : 'Your test runs will appear here.'}
            action={!search ? <Link to="/run"><Button size="sm">Run your first test</Button></Link> : undefined}
          />
        </Card>
      )}

      {runs.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead className="bg-surface-3">
                <tr className="t-label">
                  <th className="px-4 py-2 font-semibold">Started</th>
                  <th className="px-4 py-2 font-semibold">Method</th>
                  <th className="px-4 py-2 font-semibold">URL</th>
                  <th className="px-4 py-2 font-semibold">State</th>
                  <th className="px-4 py-2 text-right font-semibold">Tests</th>
                  <th className="px-4 py-2 text-right font-semibold">Findings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {runs.map((r) => (
                  <tr key={r._id} className="h-10 hover:bg-surface-2">
                    <td className="px-4">
                      <Link to={`/run/${r._id}`} className="t-mono text-[12px] text-ink-muted hover:text-accent">
                        {new Date(r.startedAt).toLocaleString()}
                      </Link>
                    </td>
                    <td className="px-4"><MethodChip method={r.target.method} /></td>
                    <td className="t-mono max-w-xs truncate px-4 text-[12.5px]">
                      <Link to={`/run/${r._id}`} className="hover:text-accent">{r.target.url}</Link>
                    </td>
                    <td className="px-4">
                      {/*
                        An ERRORED run is not a pass. This read
                        `failed > 0 ? 'fail' : 'pass'`, so a run where every
                        case errored, nothing executed at all, displayed
                        PASS with 0/5 beside it. A run only passes when every
                        case ran and every case passed.
                      */}
                      {r.state === 'COMPLETE'
                        ? <StatusChip status={runVerdict(r.summary)} />
                        : <Chip className="bg-warning-50 text-warning">{r.state}</Chip>}
                    </td>
                    <td className="t-mono px-4 text-right text-[12.5px]" data-numeric>
                      {r.summary.passed}/{r.summary.totalTests}
                    </td>
                    <td className="t-mono px-4 text-right text-[12.5px]" data-numeric>
                      {r.security?.length ?? 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/**
 * A run passes only when every case RAN and every case passed.
 *
 * `errored` counts cases that never produced a verdict: a refused permission,
 * a blocked host, a transport failure. Treating those as anything but a
 * problem would let a run that executed nothing look successful.
 */
function runVerdict(summary: TestRun['summary']): 'pass' | 'fail' | 'error' {
  if (summary.errored > 0) return 'error';
  if (summary.failed > 0 || summary.totalTests === 0) return 'fail';
  return summary.passed === summary.totalTests ? 'pass' : 'fail';
}
