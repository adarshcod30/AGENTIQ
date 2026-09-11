/**
 * API Client: docs/01_PRD.md F8, docs/04_App_UI.md §7.
 *
 * A Postman-like ad-hoc request page. Every request goes through the SAME
 * guarded egress path as the agents: permission-checked, SSRF-guarded, audited.
 * There is no side channel here.
 */
import { useState } from 'react';
import { Send, ArrowLeftRight } from 'lucide-react';
import { useSendRequest, useGrantHost } from '@/hooks/api';
import { PermissionSheet, type PermissionRequest } from '@/components/ui/PermissionSheet';
import {
  Button, Card, CardHeader, CardBody, Field, Input, Select, Textarea,
  CodeBlock, Chip, Alert, EmptyState,
} from '@/components/ui';
import { ApiError } from '@/services/api';
import type { HttpMethod, RiskClass } from '@/types';

export function ApiClientPage() {
  const send = useSendRequest();
  const grant = useGrantHost();
  const [form, setForm] = useState({
    url: '', method: 'GET' as HttpMethod, headers: '', body: '',
  });
  const [sheet, setSheet] = useState<PermissionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hostOf = (u: string) => { try { return new URL(u).host; } catch { return null; } };

  const parseHeaders = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of form.headers.split('\n')) {
      const at = line.indexOf(':');
      if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
  };

  const fire = async () => {
    setError(null);
    try {
      await send.mutateAsync({
        url: form.url, method: form.method, headers: parseHeaders(),
        ...(form.body.trim() ? { body: form.body } : {}),
      });
    } catch (err) {
      const host = hostOf(form.url);
      if (err instanceof ApiError && /approve|grant/i.test(err.message) && host) {
        setSheet({ host, riskClasses: ['network.read'] });
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Request failed.');
    }
  };

  const allow = async (granted: RiskClass[]) => {
    const host = hostOf(form.url);
    if (!host) return;
    for (const riskClass of granted) await grant.mutateAsync({ riskClass, host });
    setSheet(null);
    await fire();
  };

  const res = send.data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="t-h1">API Client</h1>
        <p className="t-small mt-1 text-ink-muted">
          Ad-hoc requests, through the same guarded path the agents use.
        </p>
      </div>

      <Card>
        <CardBody>
          <form onSubmit={(e) => { e.preventDefault(); void fire(); }} className="space-y-4">
            <div className="flex gap-2">
              <Select className="w-32" value={form.method}
                onChange={(e) => setForm((f) => ({ ...f, method: e.target.value as HttpMethod }))}>
                {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => <option key={m}>{m}</option>)}
              </Select>
              <Input mono required className="flex-1" placeholder="https://api.example.com/users"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
              <Button type="submit" loading={send.isPending}>
                <Send size={14} aria-hidden /> Send
              </Button>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Headers" htmlFor="hdrs" hint="One per line: Name: value">
                <Textarea id="hdrs" mono rows={4} value={form.headers}
                  placeholder={'Authorization: Bearer ...'}
                  onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))} />
              </Field>
              <Field label="Body" htmlFor="bdy" hint="JSON or raw text.">
                <Textarea id="bdy" mono rows={4} value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} />
              </Field>
            </div>
          </form>
        </CardBody>
      </Card>

      {error && <Alert tone="danger" title="Request failed">{error}</Alert>}

      {res && (
        <Card>
          <CardHeader
            title="Response"
            actions={
              <div className="flex items-center gap-2">
                <Chip className={res.status < 400 ? 'bg-success-50 text-success' : 'bg-danger-50 text-danger'}>
                  HTTP {res.status}
                </Chip>
                <span className="t-mono text-[12px] text-ink-muted" data-numeric>
                  {res.durationMs}ms · {res.bytes} B
                </span>
              </div>
            }
          />
          <CardBody className="space-y-3">
            <CodeBlock label="Body" code={res.body || '(empty)'} />
            <CodeBlock label="Headers" code={JSON.stringify(res.headers, null, 2)} maxHeight={200} />
            <p className="t-small text-ink-subtle">
              Resolved and connected to <span className="t-mono">{res.ip}</span>, pinned by the
              egress guard against DNS rebinding.
            </p>
          </CardBody>
        </Card>
      )}

      {!res && !error && (
        <Card>
          <EmptyState
            icon={<ArrowLeftRight size={40} strokeWidth={1.5} />}
            title="No request sent"
            body="Send a request above. Private and link-local addresses are refused by the egress guard, and every call is written to the audit log."
          />
        </Card>
      )}

      <PermissionSheet open={sheet !== null} request={sheet} submitting={grant.isPending}
        onCancel={() => setSheet(null)} onAllow={allow} />
    </div>
  );
}
