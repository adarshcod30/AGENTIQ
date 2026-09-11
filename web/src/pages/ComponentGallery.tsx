/**
 * /dev/components: every component in the library, in one place.
 *
 * The fastest way to check the design system holds together: if a screen ever
 * looks wrong, the question is whether it looks wrong HERE too.
 *
 * The sample data below is illustrative props for rendering components. It is
 * NOT mock application data. Nothing here is fetched, displayed as a metric, or
 * reachable from the authenticated app.
 */
import { useState } from 'react';
import { Inbox } from 'lucide-react';
import {
  Button, Card, CardHeader, CardBody, KpiCard, Field, Input, Select, Textarea,
  Checkbox, Chip, SeverityChip, RiskChip, MethodChip, StatusChip, CodeBlock,
  AssertionRow, FindingCard, EmptyState, Skeleton, SkeletonRows, Modal, Alert,
} from '@/components/ui';
import { PermissionSheet } from '@/components/ui/PermissionSheet';
import { ProgressList } from '@/components/ui/ProgressList';
import type { Finding, AssertionResult } from '@/types';

const ASSERTIONS: AssertionResult[] = [
  { kind: 'status', expected: '401', actual: '200', pass: false },
  { kind: 'responseTimeUnder', expected: '< 1000ms', actual: '612ms', pass: true },
  { kind: 'jsonPathExists', expected: '$.error', actual: 'not present', pass: false },
];

const FINDING: Finding = {
  family: 'SQL injection indicator',
  owasp: 'API8:2023 Security Misconfiguration',
  severity: 'high',
  vulnerable: true,
  payload: "' OR '1'='1  (query parameter \"id\")",
  signal: 'Response contained a SQLite error fingerprint: "SQLITE_ERROR: unrecognized token"',
  baseline: '200, 1204 bytes, application/json, fast (118ms): no database error.',
  explanation: 'Input appears to be concatenated into a SQL statement rather than parameterised.',
  remediation: 'Use parameterised queries. Never build SQL by string concatenation.',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="t-h2 border-b border-line pb-2">{title}</h2>
      {children}
    </section>
  );
}

export function ComponentGallery() {
  const [modalOpen, setModalOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div className="mx-auto max-w-[1000px] space-y-10 p-8">
      <header>
        <h1 className="t-display">Component gallery</h1>
        <p className="t-small mt-1 text-ink-muted">
          docs/04_App_UI.md §6. Light only, colour reserved for meaning, machine data in mono.
        </p>
      </header>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button loading>Loading in place</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </div>
      </Section>

      <Section title="KPI cards">
        <div className="grid gap-4 sm:grid-cols-3">
          {/* Zero is zero. A new account shows honest zeros, never a filled chart. */}
          <KpiCard label="Total runs" value={0} delta="No runs yet" />
          <KpiCard label="Pass rate" value="n/a" delta="Awaiting first run" />
          <KpiCard label="Open findings" value={0} />
        </div>
        <Alert tone="info">
          Delta colour is used only when the direction genuinely means good or bad. More findings
          is not &ldquo;green&rdquo; just because the number went up.
        </Alert>
      </Section>

      <Section title="Chips">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityChip severity="critical" />
          <SeverityChip severity="high" />
          <SeverityChip severity="medium" />
          <SeverityChip severity="low" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RiskChip riskClass="local.compute" />
          <RiskChip riskClass="network.read" />
          <RiskChip riskClass="network.probe" />
          <RiskChip riskClass="deploy.write" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).map((m) => (
            <MethodChip key={m} method={m} />
          ))}
          <StatusChip status="pass" />
          <StatusChip status="fail" />
          <StatusChip status="error" />
          <Chip className="bg-surface-3 text-ink-muted">neutral</Chip>
        </div>
      </Section>

      <Section title="Form controls">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="API URL" htmlFor="g-url" hint="Machine data uses mono." required>
            <Input id="g-url" mono placeholder="https://api.example.com/users" />
          </Field>
          <Field label="Method" htmlFor="g-method">
            <Select id="g-method" defaultValue="GET">
              <option>GET</option><option>POST</option><option>PUT</option>
            </Select>
          </Field>
          <Field label="With an error" htmlFor="g-err" error="Enter a valid URL." >
            <Input id="g-err" defaultValue="not-a-url" />
          </Field>
          <Field label="Description" htmlFor="g-desc">
            <Textarea id="g-desc" placeholder="What should this endpoint do?" />
          </Field>
        </div>
        <Checkbox
          id="g-public"
          label="This endpoint is intended to be public"
          hint="An anonymous 200 is then correct behaviour and is not reported."
        />
      </Section>

      <Section title="Assertion rows">
        <Card className="divide-y divide-line overflow-hidden">
          {ASSERTIONS.map((a, i) => <AssertionRow key={i} assertion={a} />)}
        </Card>
        <p className="t-small text-ink-muted">
          Expected vs actual <strong>per assertion</strong>, never per case. A failing assertion is
          never collapsed by default, and carries an icon as well as colour.
        </p>
      </Section>

      <Section title="Finding card">
        <FindingCard finding={FINDING} defaultOpen />
        <p className="t-small text-ink-muted">
          A finding with no payload and no baseline is not a finding.
        </p>
      </Section>

      <Section title="Progress list">
        <Card className="overflow-hidden">
          <ProgressList
            steps={[
              { key: 'a', label: 'Awaiting permission', state: 'done', elapsedMs: 1200 },
              { key: 'b', label: 'Generating test cases', state: 'done', elapsedMs: 1800, detail: 'llama-3.1-8b-instant, 1,240 tok' },
              { key: 'c', label: 'Executing 4 cases', state: 'active', elapsedMs: 3100, detail: '3 passed · 1 failed' },
              { key: 'd', label: 'Security scan', state: 'skipped', detail: 'not requested' },
              { key: 'e', label: 'Explaining failures', state: 'pending' },
            ]}
          />
        </Card>
        <p className="t-small text-ink-muted">
          Elapsed time is real. Nothing animates independently of actual work.
        </p>
      </Section>

      <Section title="Code block">
        <CodeBlock
          label="Response body"
          code={'{\n  "id": 1,\n  "username": "alice",\n  "role": "user"\n}'}
        />
      </Section>

      <Section title="Alerts">
        <div className="space-y-2">
          <Alert tone="info">Fetched from the running server&rsquo;s MCP registry.</Alert>
          <Alert tone="success" title="6 checks run, no indicators found">
            This is not a guarantee of security. See About for what is and is not covered.
          </Alert>
          <Alert tone="warning">network.probe has not been granted for this host.</Alert>
          <Alert tone="danger" title="Test generation failed">
            The model returned malformed JSON twice.
          </Alert>
        </div>
      </Section>

      <Section title="Empty and loading states">
        <Card>
          <EmptyState
            icon={<Inbox size={40} strokeWidth={1.5} />}
            title="No runs yet"
            body="Start your first test run to see results here."
            action={<Button size="sm">Run your first test</Button>}
          />
        </Card>
        <Card className="p-4"><SkeletonRows rows={4} /></Card>
        <div className="flex gap-3">
          <Skeleton className="h-20 flex-1" />
          <Skeleton className="h-20 flex-1" />
        </div>
      </Section>

      <Section title="Overlays">
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>
            Open permission sheet
          </Button>
        </div>

        <Modal
          open={modalOpen} onClose={() => setModalOpen(false)} title="Confirm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button onClick={() => setModalOpen(false)}>Confirm</Button>
            </>
          }
        >
          <p className="text-[13px]">Focus is trapped, and Esc cancels.</p>
        </Modal>

        <PermissionSheet
          open={sheetOpen}
          request={{ host: 'api.example.com', riskClasses: ['network.read', 'network.probe'] }}
          onCancel={() => setSheetOpen(false)}
          onAllow={() => setSheetOpen(false)}
        />
      </Section>

      <Section title="Cards">
        <Card>
          <CardHeader title="With a header" actions={<Button size="sm" variant="ghost">Action</Button>} />
          <CardBody><p className="text-[13px] text-ink-muted">Border plus a subtle shadow.</p></CardBody>
        </Card>
      </Section>
    </div>
  );
}
