/**
 * Specs: docs/03_App_Flow.md B3. Import by URL or paste, then pick an
 * operation to ground a run.
 *
 * A parse failure names the offending line (docs/01_PRD.md F4), never a stack
 * trace: the server already produces that message, so the UI just shows it.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileJson, AlertTriangle } from 'lucide-react';
import { useSpecs, useImportSpec } from '@/hooks/api';
import {
  Button, Card, CardHeader, CardBody, Field, Input, Textarea, Alert,
  SkeletonRows, EmptyState, Chip,
} from '@/components/ui';
import { ApiError } from '@/services/api';

export function SpecsPage() {
  const { data, isLoading, isError } = useSpecs();
  const importSpec = useImportSpec();
  const [mode, setMode] = useState<'url' | 'paste'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setWarnings([]);
    try {
      const result = await importSpec.mutateAsync(mode === 'url' ? { url } : { spec: text });
      setWarnings(result.warnings ?? []);
      setUrl(''); setText('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="t-h1">API Specifications</h1>
        <p className="t-small mt-1 text-ink-muted">
          Import an OpenAPI 3.x document to ground test generation in the declared contract.
        </p>
      </div>

      <Card>
        <CardHeader
          title="Import"
          actions={
            <div className="flex gap-1">
              {(['url', 'paste'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    mode === m ? 'bg-primary text-white' : 'bg-surface-3 text-ink-muted'}`}>
                  {m === 'url' ? 'By URL' : 'Paste'}
                </button>
              ))}
            </div>
          }
        />
        <CardBody>
          <form onSubmit={submit} className="space-y-3">
            {mode === 'url' ? (
              <Field label="Specification URL" htmlFor="specUrl" required
                hint="Fetched through the SSRF egress guard: private and link-local addresses are refused.">
                <Input id="specUrl" mono required value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://petstore3.swagger.io/api/v3/openapi.json" />
              </Field>
            ) : (
              <Field label="Specification document" htmlFor="specText" required
                hint="JSON or YAML.">
                <Textarea id="specText" mono required rows={8} value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={'openapi: 3.1.0\ninfo:\n  title: My API'} />
              </Field>
            )}
            {error && <Alert tone="danger" title="Could not import">{error}</Alert>}
            {warnings.map((w, i) => <Alert key={i} tone="warning">{w}</Alert>)}
            <Button type="submit" loading={importSpec.isPending}>Import</Button>
          </form>
        </CardBody>
      </Card>

      {isLoading && <Card className="p-4"><SkeletonRows rows={3} /></Card>}
      {isError && (
        <Card><EmptyState icon={<AlertTriangle size={40} strokeWidth={1.5} />}
          title="Couldn't load specifications" body="Something went wrong." /></Card>
      )}

      {!isLoading && data?.specs.length === 0 && (
        <Card>
          <EmptyState icon={<FileJson size={40} strokeWidth={1.5} />}
            title="No specifications imported"
            body="Import one above and its declared parameters, status codes and security schemes will ground every generated assertion." />
        </Card>
      )}

      {data && data.specs.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {data.specs.map((s) => (
            <Card key={s._id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="t-h3 truncate">{s.title}</h3>
                  <p className="t-small text-ink-muted">
                    v{s.version} · OpenAPI {s.openapi}
                  </p>
                </div>
                <Chip className="bg-surface-3 text-ink-muted">{s.operationCount} ops</Chip>
              </div>
              {s.sourceUrl && (
                <p className="t-mono mt-2 truncate text-[11.5px] text-ink-subtle">{s.sourceUrl}</p>
              )}
              <div className="mt-3">
                <Link to="/run"><Button size="sm" variant="secondary">Generate tests</Button></Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
