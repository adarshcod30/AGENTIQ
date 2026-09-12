/**
 * About: docs/04_App_UI.md §7.
 *
 * Says what the tool covers, and what it does not, before anyone has to ask.
 */
import { Link } from 'react-router-dom';
import { useTools, useHealth } from '@/hooks/api';
import { Card, CardHeader, CardBody, Alert, RiskChip, Chip } from '@/components/ui';

const COVERED = [
  ['SQL injection', 'API8:2023', 'DB error fingerprints plus a baseline differential.'],
  ['Reflected XSS', 'API8:2023', 'A uniquely marked payload echoed unescaped into an HTML response.'],
  ['Server-side request forgery', 'API7:2023', 'A URL parameter pointed at the cloud metadata address and an internal host, checked for a server-side fetch.'],
  ['Open redirect', 'API7:2023', 'An off-site destination injected into a redirect parameter, read from the Location header without following it.'],
  ['Broken authentication', 'API2:2023', 'Credentials stripped and forged, compared against an authenticated baseline.'],
  ['CORS misconfiguration', 'API8:2023', 'Wildcard origin with credentials, or reflection of an arbitrary origin.'],
  ['Security headers', 'API8:2023', 'HSTS, CSP, X-Content-Type-Options, X-Frame-Options.'],
  ['Rate limiting', 'API4:2023', 'Repeated requests with no 429 and no advertised budget.'],
];

const NOT_COVERED = [
  'Stored XSS, second-order injection, and anything requiring multi-step state.',
  'Business-logic flaws: the tool has no model of what your data means.',
  'Authorisation between users (IDOR) beyond the single-endpoint check.',
  'Anything requiring exploitation. Detection only, by design.',
  'Blind SSRF that needs an out-of-band callback, and dependency vulnerabilities.',
];

export function AboutPage() {
  const { data: tools } = useTools();
  const { data: health } = useHealth();

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="t-h1">About AGENTIQ</h1>
        <p className="t-small mt-1 text-ink-muted">
          What this is, what it does not do, and how to check both.
        </p>
      </div>

      <Card>
        <CardBody className="space-y-3 text-[13px] leading-relaxed">
          <p>
            You paste an API URL and a sentence of English, and get back
            <strong> executed</strong> functional tests and an OWASP-informed security scan.
            Every action is taken through a permissioned, audited tool layer, so
            &ldquo;why did it do that?&rdquo; always has an answer.
          </p>
          <p className="text-ink-muted">
            The contribution is not &ldquo;an LLM writes tests&rdquo;. It is that an LLM takes
            actions through a schema-validated, permission-gated, fully audited tool layer,
            and the whole trace is reconstructable.
          </p>
        </CardBody>
      </Card>

      <Alert tone="warning" title="A clean scan is not a guarantee of security">
        AGENTIQ checks eight families of defect on the endpoint you nominate. It does not
        replace a penetration test, a code review, or a threat model.
      </Alert>

      <Card>
        <CardHeader title="What is covered" />
        <CardBody className="space-y-2.5">
          {COVERED.map(([name, owasp, how]) => (
            <div key={name} className="text-[13px]">
              <span className="font-medium">{name}</span>{' '}
              <Chip className="bg-surface-3 text-ink-muted">{owasp}</Chip>
              <p className="t-small text-ink-muted">{how}</p>
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What is NOT covered" />
        <CardBody>
          <ul className="space-y-1.5 text-[13px] text-ink-muted">
            {NOT_COVERED.map((x) => <li key={x}>• {x}</li>)}
          </ul>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="How to check the architecture claim" />
        <CardBody className="space-y-2 text-[13px]">
          <p>
            <Link to="/tools" className="font-medium text-accent hover:underline">Tool Registry</Link>
            {' '}lists every registered tool with a schema generated from the running server.
            {tools && <> Right now that is <strong>{tools.count}</strong> tools.</>}
          </p>
          <p>
            <Link to="/audit" className="font-medium text-accent hover:underline">Audit Log</Link>
            {' '}shows every invocation, including refusals. Rows marked{' '}
            <span className="t-mono text-danger">blocked_ssrf</span> are the SSRF guard firing.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <RiskChip riskClass="local.compute" />
            <RiskChip riskClass="network.read" />
            <RiskChip riskClass="network.probe" />
            <RiskChip riskClass="deploy.write" />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Out of scope" />
        <CardBody>
          <ul className="space-y-1.5 text-[13px] text-ink-muted">
            <li>• Model fine-tuning. Grounding generation in the API's own specification does the job without a training corpus.</li>
            <li>• A browser extension for traffic capture. That is a separate product.</li>
            <li>• Graph-based stateful test chains, beyond a single auth handoff.</li>
            <li>• A vector database. Retrieving the endpoint's declared contract is what the problem needs.</li>
            <li>• Destructive security testing. A hard ethical boundary, not a preference.</li>
          </ul>
        </CardBody>
      </Card>

      {health && (
        <p className="t-small text-ink-subtle">
          Server {health.status} · database {health.mongo} · environment {health.env}
        </p>
      )}
    </div>
  );
}
