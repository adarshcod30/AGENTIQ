/**
 * Tool Registry: docs/03_App_Flow.md B6.
 *
 * "A table of all nine tools: name, description, risk class chip, and an
 * expandable live JSON Schema fetched from /api/mcp/tools. A note at the top:
 * 'Generated from the running server's tool registry. Nothing on this page is
 * hardcoded.'"
 *
 * That note is only honest because the server generates those schemas from the
 * Zod definitions on every request. Nothing on this page is a literal, if the
 * server registered eight tools, this page would show eight.
 */
import { AlertTriangle, Wrench } from 'lucide-react';
import { useTools } from '@/hooks/api';
import {
  Card, CardHeader, CardBody, RiskChip, CodeBlock, Alert, SkeletonRows, Button, EmptyState,
} from '@/components/ui';

export function ToolRegistryPage() {
  const { data, isLoading, isError, error, refetch } = useTools();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <Card className="p-4"><SkeletonRows rows={9} /></Card>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <PageHeader />
        <Card>
          <EmptyState
            icon={<AlertTriangle size={40} strokeWidth={1.5} />}
            title="Server unreachable"
            body={error instanceof Error ? error.message : 'Could not load the tool registry.'}
            action={<Button size="sm" onClick={() => refetch()}>Retry</Button>}
          />
        </Card>
      </div>
    );
  }

  // The registry is never empty in a running server: nine tools are registered
  // at boot, so there is deliberately no empty state here.
  return (
    <div className="space-y-4">
      <PageHeader />

      <Alert tone="info" title={`${data!.count} tools registered`}>
        {data!.note} Schemas are generated from the Zod definitions on every
        request, so this page cannot drift from the validator that actually runs.
      </Alert>

      <Card>
        <CardHeader title="Risk classes" />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          {data!.riskClasses.map((rc) => (
            <div key={rc.name} className="rounded-[6px] border border-line p-3">
              <div className="flex items-center gap-2">
                <RiskChip riskClass={rc.name} />
                {rc.autoGranted && <span className="t-small text-ink-muted">auto-granted</span>}
              </div>
              <p className="t-small mt-1.5 text-ink-muted">{rc.description}</p>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="space-y-2">
        {data!.tools.map((tool) => (
          <details key={tool.name} className="card">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 p-4">
              <Wrench size={16} className="shrink-0 text-ink-subtle" aria-hidden />
              <span className="t-mono font-medium text-ink">{tool.name}</span>
              <RiskChip riskClass={tool.riskClass} />
              <span className="t-small hidden min-w-0 flex-1 truncate text-ink-muted md:block">
                {tool.description}
              </span>
            </summary>

            <div className="space-y-3 border-t border-line p-4">
              <p className="text-[13px] leading-relaxed text-ink">{tool.description}</p>
              <div className="grid gap-3 lg:grid-cols-2">
                <CodeBlock
                  label="Input schema (generated)"
                  code={JSON.stringify(tool.inputSchema, null, 2)}
                  maxHeight={320}
                />
                {tool.outputSchema && (
                  <CodeBlock
                    label="Output schema (generated)"
                    code={JSON.stringify(tool.outputSchema, null, 2)}
                    maxHeight={320}
                  />
                )}
              </div>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="t-h1">Tool Registry</h1>
      <p className="t-small mt-1 text-ink-muted">
        Every capability the agents can invoke, with its permission class and live schema.
      </p>
    </div>
  );
}
