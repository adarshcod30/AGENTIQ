/**
 * Deploy: docs/01_PRD.md F5, docs/03_App_Flow.md B5.
 *
 * The screen is built around ONE distinction, and it is the reason F5 is a
 * contribution rather than a button:
 *
 *   PREFLIGHT is read-only and answers "would this deploy?"
 *   DEPLOY    is irreversible and needs a confirmed deploy.write grant.
 *
 * They are separate buttons, and preflight is the prominent one. A user can
 * find out that their package.json has no start script without first consenting
 * to a deployment, which is the whole point of having risk classes at all.
 *
 * After a successful deploy the page shows the VERIFICATION, and says plainly
 * which security families were skipped for want of an explicit grant. A partial
 * scan that looks like a full one would be worse than no scan.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  UploadCloud, CheckCircle2, AlertTriangle, XCircle, Rocket, ExternalLink, ShieldCheck, RotateCw,
} from 'lucide-react';
import {
  useDeployConfig, usePreflight, useDeploy, useDeployments, useGrantHost, useRetryDeploy,
  type DeployInput,
} from '@/hooks/api';
import { PermissionSheet, type PermissionRequest } from '@/components/ui/PermissionSheet';
import {
  Button, Card, CardHeader, CardBody, Field, Input, Select, Textarea, Checkbox,
  Alert, Chip, EmptyState, Skeleton, StatusChip,
} from '@/components/ui';
import { ApiError } from '@/services/api';
import { cn } from '@/lib/cn';
import type { PreflightCheck, Deployment, RiskClass } from '@/types';

const CHECK_LABEL: Record<string, string> = {
  'repo-format': 'Repository URL',
  'service-name': 'Service name',
  'repo-reachable': 'Repository reachable',
  'branch-exists': 'Branch exists',
  'start-command': 'Start command',
  'env-vars': 'Environment variables',
};

/** KEY=VALUE per line → an object. Blank lines and #comments ignored. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function DeployPage() {
  const config = useDeployConfig();
  const preflight = usePreflight();
  const deploy = useDeploy();
  const grant = useGrantHost();
  const history = useDeployments();

  const [form, setForm] = useState({
    provider: 'render',
    repo: '', branch: 'main', serviceName: '',
    runtime: 'node' as DeployInput['runtime'],
    plan: 'free' as DeployInput['plan'],
    region: 'oregon' as DeployInput['region'],
    buildCommand: 'npm install', startCommand: 'npm start',
    envText: '', dryRun: false,
  });
  const [sheet, setSheet] = useState<PermissionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input = (): DeployInput => ({
    provider: form.provider,
    repo: form.repo.trim(), branch: form.branch.trim(), serviceName: form.serviceName.trim(),
    runtime: form.runtime, plan: form.plan, region: form.region,
    buildCommand: form.buildCommand, startCommand: form.startCommand,
    envVars: parseEnv(form.envText), dryRun: form.dryRun,
  });

  const providers = config.data?.providers ?? [];

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  /** Turns a 403 into the sheet rather than an error string. */
  const handle = (err: unknown) => {
    if (err instanceof ApiError && err.status === 403) {
      const needs = (err.details as { needsGrant?: { riskClass: RiskClass; host: string | null }[] })
        ?.needsGrant ?? [];
      setSheet({
        host: needs.find((n) => n.host)?.host ?? 'api.github.com',
        riskClasses: needs.map((n) => n.riskClass),
      });
      return;
    }
    setError(err instanceof ApiError ? err.message : 'Something went wrong.');
  };

  const runPreflight = async () => {
    setError(null);
    try {
      const result = await preflight.mutateAsync(input());
      // Preflight returns 200 with partial results even when it was refused, so
      // the local checks are still shown. needsGrant is what opens the sheet.
      if (result.needsGrant) {
        setSheet({ host: config.data?.preflightHosts[0] ?? 'api.github.com', riskClasses: ['network.read'] });
      }
    } catch (err) { handle(err); }
  };

  const runDeploy = async () => {
    setError(null);
    try { await deploy.mutateAsync(input()); } catch (err) { handle(err); }
  };

  const allow = async (granted: RiskClass[]) => {
    for (const riskClass of granted) {
      await grant.mutateAsync(
        riskClass === 'deploy.write'
          // The checkbox IS the confirmation. deploy.write is the only class
          // where a grant alone is not enough.
          ? { riskClass, confirmed: true }
          : { riskClass, host: sheet?.host },
      );
    }
    setSheet(null);
  };

  if (config.isLoading) return <div className="space-y-4"><Skeleton className="h-64" /></div>;

  if (config.data && !config.data.configured) {
    return (
      <Card>
        <EmptyState
          icon={<UploadCloud size={40} strokeWidth={1.5} />}
          title="The deployment agent is not configured"
          body={`${config.data.note} Add a Render API key to server/.env and restart the server. Nothing is mocked here, without a credential there is no deployment to show.`}
        />
      </Card>
    );
  }

  const busy = preflight.isPending || deploy.isPending;
  const result = deploy.data?.deployment;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="t-h1">Deploy</h1>
        <p className="t-small mt-1 text-ink-muted">
          Preflight is read-only. Deploying needs an explicit, confirmed grant, and once the
          service is live, AGENTIQ tests it against the URL that just went up.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <div className="xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader title="Service" />
            <CardBody>
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void runPreflight(); }}>
                {providers.length > 0 && (
                  <Field label="Provider" htmlFor="provider"
                    hint={
                      providers.find((p) => p.name === form.provider)?.configured
                        ? undefined
                        : 'This provider has no credential configured, so a deploy will not start.'
                    }>
                    <Select id="provider" value={form.provider}
                      onChange={(e) => set('provider', e.target.value)}>
                      {providers.map((p) => (
                        <option key={p.name} value={p.name}>
                          {p.displayName}{p.status === 'stub' ? ' (preview)' : ''}
                          {p.configured ? '' : ' - not configured'}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}

                <Field label="GitHub repository" htmlFor="repo" required>
                  <Input id="repo" mono required placeholder="https://github.com/owner/repo"
                    value={form.repo} onChange={(e) => set('repo', e.target.value)} />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Branch" htmlFor="branch">
                    <Input id="branch" mono value={form.branch}
                      onChange={(e) => set('branch', e.target.value)} />
                  </Field>
                  <Field label="Service name" htmlFor="svc" required>
                    <Input id="svc" mono required placeholder="my-api"
                      value={form.serviceName} onChange={(e) => set('serviceName', e.target.value)} />
                  </Field>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <Field label="Runtime" htmlFor="runtime">
                    <Select id="runtime" value={form.runtime}
                      onChange={(e) => set('runtime', e.target.value as DeployInput['runtime'])}>
                      {['node', 'python', 'ruby', 'go', 'docker'].map((r) => <option key={r}>{r}</option>)}
                    </Select>
                  </Field>
                  <Field label="Plan" htmlFor="plan">
                    <Select id="plan" value={form.plan}
                      onChange={(e) => set('plan', e.target.value as DeployInput['plan'])}>
                      {['free', 'starter', 'standard'].map((p) => <option key={p}>{p}</option>)}
                    </Select>
                  </Field>
                  <Field label="Region" htmlFor="region">
                    <Select id="region" value={form.region}
                      onChange={(e) => set('region', e.target.value as DeployInput['region'])}>
                      {['oregon', 'frankfurt', 'singapore', 'ohio', 'virginia'].map((r) => <option key={r}>{r}</option>)}
                    </Select>
                  </Field>
                </div>

                <Field label="Build command" htmlFor="build">
                  <Input id="build" mono value={form.buildCommand}
                    onChange={(e) => set('buildCommand', e.target.value)} />
                </Field>
                <Field label="Start command" htmlFor="start">
                  <Input id="start" mono value={form.startCommand}
                    onChange={(e) => set('startCommand', e.target.value)} />
                </Field>

                <Field label="Environment variables" htmlFor="env"
                  hint="One KEY=VALUE per line. Sent to Render over TLS and stored there; AGENTIQ never persists them.">
                  <Textarea id="env" mono rows={4} placeholder={'NODE_ENV=production\nAPI_KEY=…'}
                    value={form.envText} onChange={(e) => set('envText', e.target.value)} />
                </Field>

                <div className="rounded-[6px] bg-surface-2 p-3">
                  <Checkbox id="dry" checked={form.dryRun}
                    onChange={(e) => set('dryRun', e.target.checked)}
                    label="Dry run: render the request without sending it"
                    hint="Shows the exact payload that would go to Render. No infrastructure is created." />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button type="submit" variant="secondary" loading={preflight.isPending} disabled={busy}>
                    <ShieldCheck size={16} aria-hidden /> Preflight
                  </Button>
                  <Button type="button" loading={deploy.isPending} disabled={busy}
                    onClick={() => void runDeploy()}>
                    <Rocket size={16} aria-hidden /> Deploy
                  </Button>
                </div>

                <p className="t-small text-ink-subtle">
                  Preflight only reads {config.data?.preflightHosts.join(', ')}. Deploying changes
                  systems outside AGENTIQ and asks for confirmation first.
                </p>
              </form>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-4">
          {error && <Alert tone="danger" title="Deployment failed">{error}</Alert>}

          {preflight.data && (
            <ChecklistCard
              title={preflight.data.ok ? 'Preflight passed' : 'Preflight found blocking problems'}
              tone={preflight.data.ok ? 'ok' : 'bad'}
              checks={preflight.data.checks}
            />
          )}

          {result && <DeploymentResult deployment={result} skipped={config.data?.requiresApprovalFamilies ?? []} />}

          <Card className="overflow-hidden">
            <CardHeader title="Recent deployments" />
            {history.data?.deployments.length ? (
              <div className="divide-y divide-line">
                {history.data.deployments.map((d) => (
                  <div key={d._id} className="flex items-center gap-3 px-4 py-2.5">
                    <StateChip state={d.state} />
                    <span className="t-mono min-w-0 flex-1 truncate text-[12.5px]">{d.serviceName}</span>
                    <span className="t-small text-ink-subtle">
                      {new Date(d.startedAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                icon={<UploadCloud size={36} strokeWidth={1.5} />}
                title="Nothing deployed yet"
                body="Run a preflight first: it costs one read of your repository and catches the failures that would otherwise waste a full build."
              />
            )}
          </Card>
        </div>
      </div>

      <PermissionSheet
        open={sheet !== null} request={sheet} submitting={grant.isPending}
        onCancel={() => setSheet(null)} onAllow={allow}
      />
    </div>
  );
}

function ChecklistCard({ title, tone, checks }: {
  title: string; tone: 'ok' | 'bad'; checks: PreflightCheck[];
}) {
  return (
    <Card className={cn(tone === 'bad' && 'border-danger/30')}>
      <CardHeader title={title} />
      <div className="divide-y divide-line">
        {checks.map((c) => (
          <div key={c.name} className="flex gap-3 px-4 py-2.5">
            {c.status === 'pass' && <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />}
            {c.status === 'warn' && <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />}
            {c.status === 'fail' && <XCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />}
            <div className="min-w-0">
              <p className="text-[13px] font-medium text-ink">{CHECK_LABEL[c.name] ?? c.name}</p>
              <p className="t-small text-ink-muted">{c.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StateChip({ state }: { state: Deployment['state'] }) {
  const map: Record<string, string> = {
    COMPLETE: 'bg-success-50 text-success',
    DEPLOY_FAILED: 'bg-danger-50 text-danger',
    PREFLIGHT_FAILED: 'bg-danger-50 text-danger',
    DEPLOYING: 'bg-warning-50 text-warning',
    VERIFYING: 'bg-warning-50 text-warning',
    PREFLIGHT: 'bg-surface-3 text-ink-muted',
  };
  return <Chip className={map[state] ?? 'bg-surface-3 text-ink-muted'}>{state}</Chip>;
}

function DeploymentResult({ deployment, skipped }: { deployment: Deployment; skipped: string[] }) {
  const v = deployment.verification;

  if (deployment.state !== 'COMPLETE') {
    return (
      <Card className="border-danger/30">
        <CardHeader title="Deployment did not complete" actions={<StateChip state={deployment.state} />} />
        <CardBody className="space-y-3">
          <p className="t-small text-ink">{deployment.error?.message}</p>
          {deployment.preflight.length > 0 && (
            <div className="divide-y divide-line rounded-[6px] border border-line">
              {deployment.preflight.map((c) => (
                <div key={c.name} className="flex gap-2 px-3 py-2">
                  <span className={cn('t-small font-medium',
                    c.status === 'fail' ? 'text-danger' : c.status === 'warn' ? 'text-warning' : 'text-success')}>
                    {c.status}
                  </span>
                  <span className="t-small text-ink-muted">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
          {deployment.diagnosis && <RetryPanel deployment={deployment} />}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="border-success/30">
      <CardHeader title="Deployed and verified" actions={<StateChip state={deployment.state} />} />
      <CardBody className="space-y-4">
        {deployment.liveUrl && (
          <a href={deployment.liveUrl} target="_blank" rel="noreferrer noopener"
            className="t-mono inline-flex items-center gap-1.5 text-[13px] font-medium text-accent hover:underline">
            {deployment.liveUrl} <ExternalLink size={13} aria-hidden />
          </a>
        )}

        {v && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={v.healthy ? 'pass' : 'fail'} />
            <Chip className="bg-surface-3 text-ink-muted">
              {v.testsPassed}/{v.testsTotal} tests passed against the live URL
            </Chip>
            <Chip className="bg-surface-3 text-ink-muted">{v.findings} finding(s)</Chip>
            {deployment.postDeployRunId && (
              <Link to={`/run/${deployment.postDeployRunId}`}
                className="t-small font-medium text-accent hover:underline">
                See the run
              </Link>
            )}
          </div>
        )}

        {/*
          The honest disclosure. network.probe is never auto-granted, so these
          families did NOT run. Saying so is the difference between a partial
          scan and a partial scan that looks complete.
        */}
        {skipped.length > 0 && (
          <Alert tone="info" title="Not everything was checked">
            The automatic verification ran the read-only families only.{' '}
            <strong>{skipped.join(', ')}</strong> send attack-indicator payloads, which are never
            granted automatically: run them yourself from{' '}
            <Link to="/security" className="font-medium text-accent hover:underline">Security</Link>.
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The diagnosis and, when the fix is config the platform may set, an
 * approval-gated retry. A code-change fix is shown as guidance with no retry
 * button: the platform proposes it and the user applies it, never the reverse.
 */
function RetryPanel({ deployment }: { deployment: Deployment }) {
  const retry = useRetryDeploy();
  const diagnosis = deployment.diagnosis;
  const proposal = diagnosis?.proposal;
  const [values, setValues] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState('');
  const [approved, setApproved] = useState(false);

  if (!diagnosis) return null;

  const isSetEnv = proposal?.kind === 'set-env';
  const named = proposal?.requiredEnvVars ?? [];

  const envVars = (): Record<string, string> => {
    if (named.length) return named.reduce((acc, k) => ({ ...acc, [k]: values[k] ?? '' }), {});
    return parseEnv(freeText);
  };

  const canRetry = isSetEnv && approved && !retry.isPending
    && (named.length ? named.every((k) => (values[k] ?? '').length > 0) : Object.keys(parseEnv(freeText)).length > 0);

  const retried = retry.data?.deployment;

  return (
    <div className="space-y-3 rounded-[6px] border border-line bg-surface-2 p-3">
      <div>
        <p className="text-[13px] font-medium text-ink">Diagnosis: {diagnosis.classification}</p>
        <p className="t-small mt-0.5 text-ink-muted">{diagnosis.explanation}</p>
        <p className="t-small mt-1 text-ink">{proposal?.message ?? diagnosis.suggestion}</p>
      </div>

      {proposal?.kind === 'code-change' && (
        <Alert tone="info" title="This needs a code change">
          AGENTIQ does not edit your repository. Apply the change above, then deploy again.
        </Alert>
      )}

      {isSetEnv && (
        <>
          {named.length > 0 ? (
            <div className="space-y-2">
              {named.map((k) => (
                <Field key={k} label={k} htmlFor={`env-${k}`}>
                  <Input id={`env-${k}`} mono value={values[k] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))} />
                </Field>
              ))}
            </div>
          ) : (
            <Field label="Environment variables" htmlFor="retry-env"
              hint="One KEY=VALUE per line. Set on the service and used for the redeploy; not stored by AGENTIQ.">
              <Textarea id="retry-env" mono rows={3} value={freeText}
                onChange={(e) => setFreeText(e.target.value)} placeholder={'API_KEY=…'} />
            </Field>
          )}

          <Checkbox id="retry-approve" checked={approved}
            onChange={(e) => setApproved(e.target.checked)}
            label="I approve setting this configuration and redeploying"
            hint="The deploy permission is re-checked exactly as for a first deployment." />

          <Button size="sm" disabled={!canRetry} loading={retry.isPending}
            onClick={() => retry.mutate({ id: deployment._id, approved, envVars: envVars() })}>
            <RotateCw size={15} aria-hidden /> Set config and redeploy
          </Button>
        </>
      )}

      {retry.error && (
        <Alert tone="danger">
          {retry.error instanceof ApiError ? retry.error.message : 'The retry could not start.'}
        </Alert>
      )}

      {retried && (
        <Alert tone={retried.state === 'COMPLETE' ? 'success' : 'info'}>
          Retry started as a new deployment ({retried.state}).{' '}
          {retried.error?.message ?? 'Watch it in Recent deployments below.'}
        </Alert>
      )}
    </div>
  );
}
