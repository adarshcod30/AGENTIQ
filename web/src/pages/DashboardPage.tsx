/**
 * Dashboard: docs/01_PRD.md F6.
 *
 * EVERY NUMBER ON THIS PAGE COMES FROM /api/runs/stats, which is Mongo
 * aggregation pipelines you can run yourself. None of them is a string literal
 * in this component.
 *
 * A NEW ACCOUNT SHOWS HONEST ZEROS and a call to action, never a chart
 * filled with placeholder data to look alive (docs/04_App_UI.md §10).
 */
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { PlayCircle, AlertTriangle } from 'lucide-react';
import { useStats } from '@/hooks/api';
import {
  Card, CardHeader, CardBody, KpiCard, Skeleton, EmptyState, Button,
  MethodChip, StatusChip, Chip, Alert,
} from '@/components/ui';

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'var(--color-sev-critical)',
  high: 'var(--color-sev-high)',
  medium: 'var(--color-sev-medium)',
  low: 'var(--color-sev-low)',
};

export function DashboardPage() {
  const { data, isLoading, isError, refetch } = useStats();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <EmptyState
          icon={<AlertTriangle size={40} strokeWidth={1.5} />}
          title="Couldn't load stats"
          body="The dashboard could not reach the server."
          action={<Button size="sm" onClick={() => refetch()}>Retry</Button>}
        />
      </Card>
    );
  }

  const { totals, findings, totalFindings, pulse, recent, audit } = data;

  // A brand-new account gets a call to action, not a zero-filled chart.
  if (totals.totalRuns === 0) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <Card>
          <EmptyState
            icon={<PlayCircle size={40} strokeWidth={1.5} />}
            title="No runs yet"
            body="Point AGENTIQ at an endpoint and it will generate executable test cases, run them, and show you every assertion with its expected and actual value."
            action={<Link to="/run"><Button>Run your first test</Button></Link>}
          />
        </Card>
      </div>
    );
  }

  const severityData = (['critical', 'high', 'medium', 'low'] as const)
    .map((k) => ({ name: k, value: findings[k] }))
    .filter((d) => d.value > 0);

  return (
    <div className="space-y-4">
      <PageHeader />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total runs" value={totals.totalRuns}
          delta={totals.failedRuns ? `${totals.failedRuns} failed to complete` : 'all completed'}
          direction={totals.failedRuns ? 'bad' : undefined} />
        <KpiCard label="Tests executed" value={totals.testsExecuted.toLocaleString()}
          delta={totals.discarded ? `${totals.discarded} discarded` : undefined}
          direction={totals.discarded ? 'bad' : undefined} />
        {/* passRate is NULL when nothing has run: "no data" is not "0%". */}
        <KpiCard label="Pass rate"
          value={totals.passRate === null ? 'n/a' : `${totals.passRate}%`}
          delta={`${totals.testsPassed} of ${totals.testsExecuted} passed`} />
        <KpiCard label="Open findings" value={totalFindings}
          delta={findings.critical ? `${findings.critical} critical` : undefined}
          direction={findings.critical ? 'bad' : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Run pulse: last 14 days" />
          <CardBody>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={pulse} barGap={2}>
                <CartesianGrid stroke="var(--color-line)" vertical={false} />
                <XAxis
                  dataKey="date" tickLine={false} axisLine={false}
                  tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }}
                  tickFormatter={(d: string) => d.slice(5)}
                />
                <YAxis tickLine={false} axisLine={false} allowDecimals={false}
                  tick={{ fontSize: 11, fill: 'var(--color-ink-subtle)' }} />
                <Tooltip
                  contentStyle={{
                    borderRadius: 6, border: '1px solid var(--color-line)', fontSize: 12,
                  }}
                />
                <Bar dataKey="passed" stackId="a" fill="var(--color-success)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="failed" stackId="a" fill="var(--color-danger)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Findings by severity" />
          <CardBody>
            {severityData.length === 0 ? (
              <p className="t-small py-8 text-center text-ink-muted">
                No findings recorded. That is a result, not an absence of data.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={severityData} dataKey="value" nameKey="name"
                    innerRadius={50} outerRadius={80} paddingAngle={2}>
                    {severityData.map((d) => (
                      <Cell key={d.name} fill={SEVERITY_COLOR[d.name]} />
                    ))}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ borderRadius: 6, fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardBody>
        </Card>
      </div>

      {/* The tool layer, visible on the dashboard itself. */}
      {(audit.denied > 0 || audit.blocked_ssrf > 0) && (
        <Alert tone="info" title="The guard is firing">
          {audit.blocked_ssrf > 0 && <>{audit.blocked_ssrf} request(s) blocked as SSRF. </>}
          {audit.denied > 0 && <>{audit.denied} refused for want of a permission grant. </>}
          <Link to="/audit" className="font-medium text-accent hover:underline">See the audit log</Link>.
        </Alert>
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="Recent runs"
          actions={<Link to="/history"><Button size="sm" variant="ghost">All runs</Button></Link>}
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left">
            <thead className="bg-surface-3">
              <tr className="t-label">
                <th className="px-4 py-2 font-semibold">Started</th>
                <th className="px-4 py-2 font-semibold">Method</th>
                <th className="px-4 py-2 font-semibold">URL</th>
                <th className="px-4 py-2 font-semibold">Result</th>
                <th className="px-4 py-2 text-right font-semibold">Findings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {recent.map((r) => (
                <tr key={r.id} className="h-10 hover:bg-surface-2">
                  <td className="t-mono px-4 text-[12px] text-ink-muted" data-numeric>
                    <Link to={`/run/${r.id}`}>{new Date(r.startedAt).toLocaleString()}</Link>
                  </td>
                  <td className="px-4"><MethodChip method={r.method} /></td>
                  <td className="t-mono max-w-xs truncate px-4 text-[12.5px]">
                    <Link to={`/run/${r.id}`} className="hover:text-accent">{r.url}</Link>
                  </td>
                  <td className="px-4">
                    {r.state === 'COMPLETE'
                      ? <StatusChip status={r.passed === r.totalTests ? 'pass' : 'fail'} />
                      : <Chip className="bg-warning-50 text-warning">{r.state}</Chip>}
                  </td>
                  <td className="t-mono px-4 text-right text-[12.5px]" data-numeric>{r.findings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="t-small text-ink-subtle">
        {totals.tokensUsed.toLocaleString()} tokens used
        {totals.costUsd > 0 && <> · ${totals.costUsd.toFixed(4)} estimated</>}
        {totals.medianLatencyMs !== null && <> · median response {totals.medianLatencyMs}ms</>}
      </p>
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="t-h1">Dashboard</h1>
      <p className="t-small mt-1 text-ink-muted">
        Every figure below is a Mongo aggregation over your runs. Nothing is hardcoded.
      </p>
    </div>
  );
}
