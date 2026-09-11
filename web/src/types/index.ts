/**
 * Shared API types.
 *
 * Mirrors the server's response shapes (docs/02_TRD.md §9). Kept hand-written
 * rather than generated: the surface is small, and a generator would be one
 * more build step to maintain.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type RiskClass = 'local.compute' | 'network.read' | 'network.probe' | 'deploy.write';
export type AuditOutcome = 'ok' | 'denied' | 'error' | 'blocked_ssrf' | 'rate_limited';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type RunState =
  | 'DRAFT' | 'AWAITING_GRANT' | 'CANCELLED'
  | 'GENERATING' | 'GEN_FAILED'
  | 'EXECUTING' | 'EXEC_FAILED'
  | 'SCANNING' | 'EXPLAINING' | 'COMPLETE';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: 'user' | 'admin';
  /** Soft by design: an unverified user can sign in and sees a banner. */
  emailVerified: boolean;
  emailVerifiedAt?: string | null;
}

export interface AssertionResult {
  kind: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface FunctionalResult {
  name: string;
  intent?: string;
  category?: 'positive' | 'negative' | 'boundary';
  status: 'pass' | 'fail' | 'error';
  httpStatus: number | null;
  responseTimeMs: number;
  assertions: AssertionResult[];
  error?: string | null;
  explanation?: string;
}

export interface Finding {
  family: string;
  owasp: string;
  severity: Severity;
  vulnerable: boolean;
  payload: string | null;
  signal: string | null;
  baseline: string | null;
  explanation: string;
  remediation: string;
}

export interface RunSummary {
  totalTests: number;
  passed: number;
  failed: number;
  errored: number;
  discarded: number;
  assertionsEvaluated: number;
  findings: { critical: number; high: number; medium: number; low: number };
}

export interface TestRun {
  id: string;
  _id: string;
  state: RunState;
  stateHistory: { state: RunState; at: string; note?: string }[];
  target: { url: string; method: HttpMethod; description: string; intendedPublic: boolean };
  grounded: boolean;
  summary: RunSummary;
  functional: FunctionalResult[];
  security: Finding[];
  generation?: {
    provider?: string; model?: string;
    inputTokens: number; outputTokens: number;
    costUsd?: number; attempts?: number; generationMs?: number;
  };
  error?: { code: string; message: string };
  startedAt: string;
  finishedAt?: string;
  durationMs: number | null;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  riskClass: RiskClass;
  riskClassMeta: {
    label: string; description: string;
    autoGranted: boolean; requiresHost: boolean; requiresConfirmation: boolean;
  };
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}

export interface AuditEvent {
  _id: string;
  tool: string;
  riskClass: RiskClass;
  targetHost: string | null;
  inputHash: string;
  outcome: AuditOutcome;
  errorCode: string | null;
  reason: string | null;
  durationMs: number;
  ts: string;
  runId: string | null;
}

export interface Grant {
  riskClass: RiskClass;
  host: string | null;
  confirmed: boolean;
  grantedAt: number;
  expiresAt: number;
}

export interface SpecOperation {
  operationId: string | null;
  method: HttpMethod;
  path: string;
  summary: string | null;
  parameters: { name: string; in: string; required: boolean }[];
  responses: { status: string; description: string | null }[];
  security: string[];
}

export interface ApiSpec {
  _id: string;
  title: string;
  version: string;
  openapi: string;
  sourceUrl: string | null;
  operationCount: number;
  operations: SpecOperation[];
  securitySchemes: { name: string; type: string; scheme: string | null }[];
  createdAt: string;
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  uptime: number;
  mongo: string;
  llmProviders: { name: string; configured: boolean; role: string }[];
  /** The chain as providerOrder() will actually resolve it, with per-task models. */
  llmChain: {
    order: string[];
    hasFallback: boolean;
    models: Record<string, Record<string, string>>;
  };
  mail: { configured: boolean; driver: string };
  googleOAuth: string;
  env: string;
}

/* ── Deployment (F5) ───────────────────────────────────────────────────────── */

export type DeployState =
  | 'PREFLIGHT' | 'PREFLIGHT_FAILED' | 'DEPLOYING' | 'DEPLOY_FAILED' | 'VERIFYING' | 'COMPLETE';

export interface PreflightCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface Deployment {
  _id: string;
  provider: string;
  repo: string;
  branch: string;
  serviceName: string;
  state: DeployState;
  stateHistory: { state: string; at: string; note?: string }[];
  preflight: PreflightCheck[];
  serviceId: string | null;
  deployId: string | null;
  liveUrl: string | null;
  postDeployRunId: string | null;
  verification?: {
    testsPassed: number;
    testsTotal: number;
    findings: number;
    healthy: boolean;
  };
  error?: { code: string; message: string };
  startedAt: string;
  finishedAt?: string;
}

export interface DeployConfig {
  configured: boolean;
  provider: string;
  preflightHosts: string[];
  autoVerifyFamilies: string[];
  requiresApprovalFamilies: string[];
  note: string;
}
