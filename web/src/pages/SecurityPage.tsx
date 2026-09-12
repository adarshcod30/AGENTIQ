/**
 * Security: docs/03_App_Flow.md B4.
 *
 * Eight families shown as `not yet run` / `running` / `clean` / `N findings`,
 * then findings sorted by severity.
 *
 * The "intended to be public" checkbox is LOAD-BEARING and the page says so.
 * Without it the auth probe would report every public API as having broken
 * authentication.
 */
import { useState } from 'react';
import { ShieldCheck, ShieldAlert, Circle, Loader2 } from 'lucide-react';
import { useScan, useGrantHost } from '@/hooks/api';
import { PermissionSheet, type PermissionRequest } from '@/components/ui/PermissionSheet';
import {
  Button, Card, CardHeader, CardBody, Field, Input, Select, Checkbox,
  FindingCard, Alert, Chip,
} from '@/components/ui';
import { ApiError } from '@/services/api';
import { cn } from '@/lib/cn';
import type { HttpMethod, RiskClass } from '@/types';

const FAMILY_LABELS: Record<string, string> = {
  sqli: 'SQL injection',
  xss: 'Reflected XSS',
  ssrf: 'Server-side request forgery',
  redirect: 'Open redirect',
  auth: 'Broken authentication',
  cors: 'CORS misconfiguration',
  headers: 'Security headers',
  rate: 'Rate limiting',
};

const ALL_FAMILIES = Object.keys(FAMILY_LABELS);

export function SecurityPage() {
  const scan = useScan();
  const grant = useGrantHost();
  const [form, setForm] = useState({
    url: '', method: 'GET' as HttpMethod, intendedPublic: false,
  });
  const [sheet, setSheet] = useState<PermissionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hostOf = (u: string) => { try { return new URL(u).host; } catch { return null; } };

  const run = async () => {
    setError(null);
    try {
      const result = await scan.mutateAsync(form);
      // Some families were refused for want of a grant. Show the sheet: the
      // read-only families still ran, so this is a partial result, not a failure.
      if (result.needsGrant) {
        const host = hostOf(form.url);
        if (host) setSheet({ host, riskClasses: ['network.read', 'network.probe'] });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Scan failed.');
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostOf(form.url)) { setError('Enter a full http(s) URL.'); return; }
    void run();
  };

  const allow = async (granted: RiskClass[]) => {
    const host = hostOf(form.url);
    if (!host) return;
    for (const riskClass of granted) await grant.mutateAsync({ riskClass, host });
    setSheet(null);
    await run();
  };

  const result = scan.data;
  const busy = scan.isPending || grant.isPending;

  const familyState = (key: string): 'not-run' | 'running' | 'clean' | 'findings' | 'error' => {
    if (busy) return 'running';
    const f = result?.families.find((x) => x.family === key);
    if (!f) return 'not-run';
    if (f.error) return 'error';
    return f.findings.length > 0 ? 'findings' : 'clean';
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[400px_1fr]">
      <div className="xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader title="Scan an endpoint" />
          <CardBody>
            <form onSubmit={submit} className="space-y-4">
              <Field label="Target URL" htmlFor="scanUrl" required>
                <Input id="scanUrl" mono required placeholder="https://api.example.com/users/1"
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
              </Field>

              <Field label="Method" htmlFor="scanMethod">
                <Select id="scanMethod" value={form.method}
                  onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as HttpMethod }))}>
                  {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => <option key={m}>{m}</option>)}
                </Select>
              </Field>

              <div className="rounded-[6px] bg-surface-2 p-3">
                <Checkbox
                  id="scanPublic"
                  checked={form.intendedPublic}
                  onChange={(e) => setForm((f) => ({ ...f, intendedPublic: e.target.checked }))}
                  label="This endpoint is intended to be public"
                  hint="An anonymous 200 is then CORRECT behaviour, and the authentication family reports nothing. This is what prevents a false positive on every public API."
                />
              </div>

              <Button type="submit" loading={busy} className="w-full">
                <ShieldAlert size={16} aria-hidden /> Run scan
              </Button>

              <p className="t-small text-ink-muted">
                Read-only and non-destructive. Payloads never modify data, and outbound
                traffic is rate-limited to 5 requests per second per host.
              </p>
            </form>
          </CardBody>
        </Card>
      </div>

      <div className="space-y-4">
        {error && <Alert tone="danger" title="Scan failed">{error}</Alert>}

        <Card>
          <CardHeader title="Families" />
          <div className="divide-y divide-line">
            {ALL_FAMILIES.map((key) => {
              const state = familyState(key);
              const f = result?.families.find((x) => x.family === key);
              return (
                <div key={key} className="flex items-center gap-3 px-4 py-2.5">
                  {state === 'running' && <Loader2 size={16} className="animate-spin text-accent" aria-hidden />}
                  {state === 'clean' && <ShieldCheck size={16} className="text-success" aria-hidden />}
                  {state === 'findings' && <ShieldAlert size={16} className="text-danger" aria-hidden />}
                  {(state === 'not-run' || state === 'error') && (
                    <Circle size={16} className="text-line" aria-hidden />
                  )}

                  <span className="min-w-0 flex-1 text-[13px] text-ink">{FAMILY_LABELS[key]}</span>

                  <span className={cn(
                    't-small',
                    state === 'findings' && 'font-medium text-danger',
                    state === 'clean' && 'text-success',
                    state === 'not-run' && 'text-ink-subtle',
                    state === 'error' && 'text-warning',
                  )}>
                    {state === 'not-run' && 'not yet run'}
                    {state === 'running' && 'running'}
                    {state === 'clean' && 'clean'}
                    {state === 'error' && 'not permitted'}
                    {state === 'findings' && `${f!.findings.length} finding${f!.findings.length === 1 ? '' : 's'}`}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>

        {result && result.findings.length === 0 && (
          /* The clean result is a DESIGNED state carrying the honest sentence. */
          <Card className="border-success/30 bg-success-50">
            <CardBody className="flex gap-3">
              <ShieldCheck size={20} className="mt-0.5 shrink-0 text-success" aria-hidden />
              <div>
                <h3 className="t-h3">{result.summary.familiesRun} checks run, no indicators found</h3>
                <p className="t-small mt-1 text-ink">
                  This is not a guarantee of security. See{' '}
                  <a href="/about" className="font-medium text-accent hover:underline">About</a>{' '}
                  for what is and is not covered.
                </p>
              </div>
            </CardBody>
          </Card>
        )}

        {result && result.findings.length > 0 && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {(['critical', 'high', 'medium', 'low'] as const).map((s) =>
                result.summary.bySeverity[s] ? (
                  <Chip key={s} className="bg-surface-3 text-ink-muted">
                    {result.summary.bySeverity[s]} {s}
                  </Chip>
                ) : null)}
            </div>
            {[...result.findings]
              .sort((a, b) => {
                const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
                return order[a.severity] - order[b.severity];
              })
              .map((f, i) => <FindingCard key={i} finding={f} defaultOpen={i === 0} />)}
          </div>
        )}
      </div>

      <PermissionSheet
        open={sheet !== null} request={sheet} submitting={grant.isPending}
        onCancel={() => setSheet(null)} onAllow={allow}
      />
    </div>
  );
}
