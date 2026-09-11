/**
 * Run detail: docs/03_App_Flow.md B2, docs/04_App_UI.md §7.
 *
 * Deep-linkable: every run has a URL. Four states, per Part C:
 * loading skeletons, "Run not found" + back, and the populated view.
 */
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { useRun } from '@/hooks/api';
import { Card, CardHeader, MethodChip, Chip, Skeleton, EmptyState, Button, Alert } from '@/components/ui';
import { ProgressList, stepsFromRun } from '@/components/ui/ProgressList';
import { RunResults } from '@/components/RunResults';

export function RunDetailPage() {
  const { id } = useParams();
  const { data, isLoading, isError } = useRun(id);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <EmptyState
          icon={<AlertTriangle size={40} strokeWidth={1.5} />}
          title="Run not found"
          body="This run does not exist, or it belongs to another account."
          action={<Link to="/history"><Button size="sm" variant="secondary">Back to history</Button></Link>}
        />
      </Card>
    );
  }

  const run = data.run;

  return (
    <div className="space-y-4">
      <Link to="/history" className="t-small inline-flex items-center gap-1 text-ink-muted hover:text-ink">
        <ArrowLeft size={14} aria-hidden /> History
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <MethodChip method={run.target.method} />
        <h1 className="t-mono min-w-0 flex-1 truncate text-[15px] font-medium">{run.target.url}</h1>
        <Chip className="bg-surface-3 text-ink-muted">{run.state}</Chip>
        <span className="t-small text-ink-muted">
          {new Date(run.startedAt).toLocaleString()}
        </span>
      </div>

      {run.target.description && (
        <p className="t-small text-ink-muted">{run.target.description}</p>
      )}

      {run.error && (
        <Alert tone={run.state === 'CANCELLED' ? 'warning' : 'danger'} title={run.error.code}>
          {run.error.message}
        </Alert>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Progress" />
        <ProgressList steps={stepsFromRun(run)} />
      </Card>

      <RunResults run={run} />
    </div>
  );
}
