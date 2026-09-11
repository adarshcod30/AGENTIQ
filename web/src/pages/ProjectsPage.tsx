/**
 * Projects: register a local project and launch an autonomous assessment.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §F. A project is a name and the path to a folder
 * on the machine running the server. Registering one lets AGENTIQ discover its
 * routes, start it, test it, scan it and judge its readiness, with no URL typed.
 *
 * The workspace path is deliberately plain text: the server holds the filesystem
 * jail, and a path outside it is refused there, not hidden here.
 */
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FolderPlus, Play, FolderGit2, Clock } from 'lucide-react';
import {
  useProjects, useCreateProject, useAssessments, useCreateAssessment,
} from '@/hooks/api';
import {
  Card, CardHeader, CardBody, Button, Field, Input, Alert, Chip, EmptyState, SkeletonRows,
} from '@/components/ui';
import { ApiError } from '@/services/api';
import type { AssessState } from '@/types';

const ASSESS_CHIP: Record<string, string> = {
  COMPLETE: 'bg-success-50 text-success',
  FAILED: 'bg-danger-50 text-danger',
  AWAITING_INPUT: 'bg-warning-50 text-warning',
  PENDING: 'bg-surface-3 text-ink-muted',
};

export function AssessChip({ state }: { state: AssessState }) {
  return <Chip className={ASSESS_CHIP[state] ?? 'bg-info-50 text-info'}>{state.replace(/_/g, ' ')}</Chip>;
}

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const create = useCreateProject();
  const runAssessment = useCreateAssessment();
  const recent = useAssessments();

  const [name, setName] = useState('');
  const [root, setRoot] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      await create.mutateAsync({ name: name.trim(), workspaceRoot: root.trim() });
      setName('');
      setRoot('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add the project.');
    }
  };

  const start = async (projectId: string) => {
    setError(null);
    try {
      const { assessment } = await runAssessment.mutateAsync({ projectId });
      navigate(`/assessments/${assessment._id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the assessment.');
    }
  };

  const list = projects.data?.projects ?? [];
  const recents = recent.data?.assessments ?? [];

  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="t-h1">Projects</h1>
        <p className="t-small mt-1 text-ink-muted">
          Point AGENTIQ at a project folder on this machine. It discovers the routes, runs the app,
          tests it and scans it, then judges whether it is ready to deploy.
        </p>
      </div>

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <Card>
        <CardHeader title="Add a project" />
        <CardBody>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Field label="Name" htmlFor="proj-name" required>
              <Input id="proj-name" required placeholder="my-api"
                value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Workspace path" htmlFor="proj-root" required
              hint="An absolute path to the project folder on the server host.">
              <Input id="proj-root" mono required placeholder="/Users/you/code/my-api"
                value={root} onChange={(e) => setRoot(e.target.value)} />
            </Field>
            <Button type="submit" loading={create.isPending} disabled={!name.trim() || !root.trim()}>
              <FolderPlus size={16} aria-hidden /> Add project
            </Button>
          </form>
        </CardBody>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Your projects" />
        {projects.isLoading && <CardBody><SkeletonRows rows={2} /></CardBody>}
        {!projects.isLoading && list.length === 0 && (
          <EmptyState
            icon={<FolderGit2 size={36} strokeWidth={1.5} />}
            title="No projects yet"
            body="Add a project above to run your first autonomous assessment."
          />
        )}
        {list.length > 0 && (
          <div className="divide-y divide-line">
            {list.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink">{p.name}</p>
                  <p className="t-mono truncate text-[12px] text-ink-muted">{p.workspaceRoot}</p>
                </div>
                <span className="t-small text-ink-subtle">
                  {p.lastDiscoveryAt
                    ? `discovered ${new Date(p.lastDiscoveryAt).toLocaleDateString()}`
                    : 'not discovered yet'}
                </span>
                <Button size="sm" loading={runAssessment.isPending}
                  onClick={() => void start(p.id)}>
                  <Play size={15} aria-hidden /> Run assessment
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Recent assessments" />
        {recent.isLoading && <CardBody><SkeletonRows rows={2} /></CardBody>}
        {!recent.isLoading && recents.length === 0 && (
          <EmptyState
            icon={<Clock size={36} strokeWidth={1.5} />}
            title="No assessments yet"
            body="Run an assessment on a project and it will appear here with a live phase timeline."
          />
        )}
        {recents.length > 0 && (
          <div className="divide-y divide-line">
            {recents.slice(0, 12).map((a) => (
              <Link key={a._id} to={`/assessments/${a._id}`}
                className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                <AssessChip state={a.state} />
                <span className="t-small min-w-0 flex-1 truncate text-ink-muted">
                  {a.endpoints.length} endpoint(s), {a.security.findings.length} finding(s)
                </span>
                <span className="t-small text-ink-subtle">{new Date(a.startedAt).toLocaleString()}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
