/**
 * Test Runner: docs/03_App_Flow.md B1.
 *
 * THE NON-NEGOTIABLE: the permission sheet appears BEFORE any packet leaves the
 * server, with network.probe unchecked by default. The server enforces this
 * independently (a run against an ungranted host comes back CANCELLED with
 * AWAITING_GRANT and no traffic sent), so the sheet is the human-facing half of
 * a guarantee, not the guarantee itself.
 *
 * GENERATION FAILURE IS AN ERROR, NOT A FALLBACK. Canned cases returned when the
 * LLM fails would make a broken run look like a successful one.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlayCircle, AlertTriangle } from 'lucide-react';
import { useStartRun, useGrantHost, useSpecs } from '@/hooks/api';
import { PermissionSheet, type PermissionRequest } from '@/components/ui/PermissionSheet';
import { ProgressList, stepsFromRun } from '@/components/ui/ProgressList';
import {
  Button, Card, CardBody, CardHeader, Field, Input, Select, Textarea, Checkbox, Alert, EmptyState,
} from '@/components/ui';
import { RunResults } from '@/components/RunResults';
import { ApiError } from '@/services/api';
import type { HttpMethod, RiskClass, TestRun } from '@/types';

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function TestRunnerPage() {
  const navigate = useNavigate();
  const startRun = useStartRun();
  const grant = useGrantHost();
  const { data: specsData } = useSpecs();

  const [form, setForm] = useState({
    url: '', method: 'GET' as HttpMethod, description: '',
    count: 4, intendedPublic: false, specRef: '', operationIndex: '',
    alsoScan: false,
  });
  const [sheet, setSheet] = useState<PermissionRequest | null>(null);
  const [run, setRun] = useState<TestRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedSpec = specsData?.specs.find((s) => s._id === form.specRef);

  const hostOf = (url: string) => {
    try { return new URL(url).host; } catch { return null; }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setRun(null);

    const host = hostOf(form.url);
    if (!host) { setError('Enter a full http(s) URL.'); return; }

    await launch();
  };

  const launch = async () => {
    try {
      const { run: result } = await startRun.mutateAsync({
        url: form.url,
        method: form.method,
        description: form.description,
        count: form.count,
        intendedPublic: form.intendedPublic,
        ...(form.specRef ? { specRef: form.specRef } : {}),
        ...(form.operationIndex !== '' ? { operationIndex: Number(form.operationIndex) } : {}),
      });

      // The server refused because the host is not approved for this session.
      // NO packet has left. Show the sheet: this is the moment the
      // architecture becomes visible to a human.
      if (result.state === 'CANCELLED' && result.error?.code === 'AWAITING_GRANT') {
        setSheet({
          host: hostOf(form.url)!,
          riskClasses: form.alsoScan
            ? ['network.read', 'network.probe']
            : ['network.read'],
        });
        return;
      }

      setRun(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the run.');
    }
  };

  const allow = async (granted: RiskClass[]) => {
    const host = hostOf(form.url);
    if (!host) return;
    for (const riskClass of granted) {
      await grant.mutateAsync({ riskClass, host });
    }
    setSheet(null);
    await launch();
  };

  const busy = startRun.isPending || grant.isPending;

  return (
    <div className="grid gap-6 xl:grid-cols-[400px_1fr]">
      {/* ── Form (sticky at wide widths, docs/04_App_UI.md §7) ────────────── */}
      <div className="xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader title="New run" />
          <CardBody>
            <form onSubmit={submit} className="space-y-4">
              <Field label="API URL" htmlFor="url" required
                hint="The endpoint you want tested.">
                <Input
                  id="url" mono required placeholder="https://api.example.com/users/1"
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Method" htmlFor="method">
                  <Select id="method" value={form.method}
                    onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as HttpMethod }))}>
                    {METHODS.map((m) => <option key={m}>{m}</option>)}
                  </Select>
                </Field>
                <Field label="Cases" htmlFor="count">
                  <Input id="count" type="number" min={1} max={12} value={form.count}
                    onChange={(e) => setForm((f) => ({ ...f, count: Number(e.target.value) }))} />
                </Field>
              </div>

              <Field label="What should this endpoint do?" htmlFor="description" required
                hint="Plain English. This is what the model reasons about.">
                <Textarea
                  id="description" required rows={3}
                  placeholder="Returns a single user by id, or 404 when the id is unknown."
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
              </Field>

              {specsData && specsData.specs.length > 0 && (
                <Field label="Ground in a specification" htmlFor="spec"
                  hint="Assertions will reference declared response fields.">
                  <Select id="spec" value={form.specRef}
                    onChange={(e) => setForm((f) => ({ ...f, specRef: e.target.value, operationIndex: '' }))}>
                    <option value="">No specification</option>
                    {specsData.specs.map((s) => (
                      <option key={s._id} value={s._id}>{s.title} v{s.version}</option>
                    ))}
                  </Select>
                </Field>
              )}

              {selectedSpec && selectedSpec.operations?.length > 0 && (
                <Field label="Operation" htmlFor="operation">
                  <Select id="operation" value={form.operationIndex}
                    onChange={(e) => setForm((f) => ({ ...f, operationIndex: e.target.value }))}>
                    <option value="">Match by method</option>
                    {selectedSpec.operations.map((op, i) => (
                      <option key={i} value={i}>{op.method} {op.path}</option>
                    ))}
                  </Select>
                </Field>
              )}

              <div className="space-y-3 rounded-[6px] bg-surface-2 p-3">
                <Checkbox
                  id="intendedPublic"
                  checked={form.intendedPublic}
                  onChange={(e) => setForm((f) => ({ ...f, intendedPublic: e.target.checked }))}
                  label="This endpoint is intended to be public"
                  hint="An anonymous 200 is then correct behaviour and is not reported as a finding."
                />
                <Checkbox
                  id="alsoScan"
                  checked={form.alsoScan}
                  onChange={(e) => setForm((f) => ({ ...f, alsoScan: e.target.checked }))}
                  label="Also run a security scan"
                  hint="Requires the network.probe permission, which you approve per host."
                />
              </div>

              <Button type="submit" loading={busy} className="w-full">
                <PlayCircle size={16} aria-hidden /> Run tests
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>

      {/* ── Results ───────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        {error && <Alert tone="danger" title="Could not start the run">{error}</Alert>}

        {busy && !run && (
          <Card>
            <CardHeader title="Running" />
            <ProgressList steps={[
              { key: 'grant', label: 'Checking permission', state: 'active' },
              { key: 'generate', label: 'Generating test cases', state: 'pending' },
              { key: 'execute', label: 'Executing cases', state: 'pending' },
              { key: 'scan', label: 'Security scan', state: 'pending' },
              { key: 'explain', label: 'Explaining failures', state: 'pending' },
            ]} />
          </Card>
        )}

        {run && (
          <>
            <Card className="overflow-hidden">
              <CardHeader
                title="Progress"
                actions={
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/run/${run._id}`)}>
                    Open run detail
                  </Button>
                }
              />
              <ProgressList steps={stepsFromRun(run)} />
            </Card>

            {/* GEN_FAILED is a visible, named error, never a fabricated pass. */}
            {run.state === 'GEN_FAILED' && (
              <Alert tone="danger" title="Test generation failed">
                {run.error?.message}
                <div className="mt-2">
                  <Button size="sm" variant="secondary" onClick={launch}>Retry</Button>
                </div>
              </Alert>
            )}

            <RunResults run={run} />
          </>
        )}

        {!run && !busy && !error && (
          <Card>
            <EmptyState
              icon={<PlayCircle size={40} strokeWidth={1.5} />}
              title="No run yet"
              body="Describe an endpoint on the left and AGENTIQ will generate executable test cases, run them, and show you every assertion."
            />
          </Card>
        )}
      </div>

      <PermissionSheet
        open={sheet !== null}
        request={sheet}
        submitting={grant.isPending}
        onCancel={() => setSheet(null)}
        onAllow={allow}
      />
    </div>
  );
}

export { AlertTriangle };
