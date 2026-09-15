/**
 * Shared API types.
 *
 * Mirrors the server's response shapes (docs/02_TRD.md §9). Kept hand-written
 * rather than generated: the surface is small, and a generator would be one
 * more build step to maintain.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type RiskClass =
  | 'local.compute' | 'local.fs.read' | 'local.process'
  | 'network.read' | 'network.probe' | 'deploy.write';
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

/** What a retry can do: config the platform may set, or a code change it will not. */
export interface RetryProposal {
  retryable: boolean;
  kind: 'set-env' | 'code-change' | 'none';
  requiredEnvVars: string[];
  requiresApproval: boolean;
  message: string;
}

export interface DeployDiagnosis {
  classification: string;
  explanation: string;
  suggestion: string;
  safeFix: { type?: string; key?: string | null; behaviourChanging?: boolean } | null;
  proposal?: RetryProposal;
}

export interface DeployProvider {
  name: string;
  displayName: string;
  status: 'available' | 'stub';
  requiresCredential: string;
  configured: boolean;
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
  diagnosis?: DeployDiagnosis | null;
  retryOf?: string | null;
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
  providers: DeployProvider[];
  preflightHosts: string[];
  autoVerifyFamilies: string[];
  requiresApprovalFamilies: string[];
  note: string;
}

/* ── Projects and assessments (autonomous platform, Phase 1-7) ─────────────── */

export interface Project {
  id: string;
  _id?: string;
  name: string;
  /** Local folder path. Null for a URL-only project. */
  workspaceRoot: string | null;
  /** Deployed base URL to assess. Null for a folder-only project. */
  targetUrl?: string | null;
  /** Source GitHub repo, when the workspace was cloned from one. */
  repoUrl?: string | null;
  /** False when the code is external (a cloned repo): it is never started. */
  trusted?: boolean;
  /** For a GitHub project: the state of its background clone. */
  cloneStatus?: 'ready' | 'cloning' | 'failed';
  /** Why the clone failed, when cloneStatus is 'failed'. */
  cloneError?: string | null;
  lastDiscoveryAt: string | null;
  /** Names only of the opt-in runtime env; values never leave the server. */
  runtimeEnvKeys?: string[];
  /** Optional npm script that starts the app under test (not a secret). */
  startScript?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A user's own third-party account link. Presence only; the token never leaves the server. */
export interface Connection {
  provider: 'github' | 'render' | 'vercel';
  authType?: 'token' | 'oauth';
  connected: boolean;
  last4?: string | null;
  updatedAt?: string;
}

// ── BYOK AI providers ────────────────────────────────────────────────────────

export interface AiProviderField {
  key: string;
  label: string;
  type: 'secret' | 'text';
  required: boolean;
  placeholder: string | null;
  default: string | null;
}

export interface AiProviderSpec {
  provider: string;
  label: string;
  fields: AiProviderField[];
}

export interface AiProviderStatus {
  provider: string;
  connected: boolean;
  config: Record<string, string>;
  hints: Record<string, string>;
  verified: boolean;
  verifiedAt: string | null;
  active: boolean;
  updatedAt?: string;
}

export type AssessState =
  | 'PENDING' | 'DISCOVERING' | 'TESTING' | 'AWAITING_INPUT'
  | 'SCANNING' | 'ANALYZING' | 'REPORTING' | 'COMPLETE' | 'FAILED';

export interface AssessmentEndpoint {
  method: string;
  path: string;
  intent: string | null;
  confidence: string | null;
  passed: number;
  failed: number;
  errored: number;
  status: 'complete' | 'skipped' | 'failed';
  note?: string;
}

export interface AssessmentFinding {
  lane: string;
  category: string;
  severity: Severity | 'info';
  confidence: string;
  title: string;
  description: string;
  evidence: string;
  remediation: string;
  owasp: string | null;
  location: { file: string | null; line: number | null; endpoint: string | null };
}

export interface Clarification {
  endpoint: string;
  question: string;
  answer: string | null;
}

export interface Recommendation {
  id: string;
  stage: 'Discovery' | 'Testing' | 'Security' | 'Deployment';
  priority: 1 | 2 | 3 | 4;
  title: string;
  why: string;
  fix: string;
  tips: string[];
  where?: string[];
}

export interface AssessmentReport {
  generatedAt: string;
  project: { framework: string; endpointCount: number; dependencyCount: number };
  discoveredApis: { method: string; path: string; intent: string | null; confidence: string | null }[];
  testing: {
    endpointsTested: number;
    endpointsSkipped: number;
    endpointsWithFailures: string[];
  };
  security: { total: number; bySeverity: Record<string, number>; notes: string[] };
  readiness: { ready: boolean; blockers: string[]; warnings: string[] };
  recommendations: Recommendation[];
  recommendationSummary: { total: number; byPriority: Record<string, number> };
}

export interface Assessment {
  _id: string;
  projectId: string;
  state: AssessState;
  stateHistory: { state: AssessState; at: string; note?: string }[];
  baseUrl: string | null;
  endpoints: AssessmentEndpoint[];
  security: {
    findings: AssessmentFinding[];
    summary: { total: number; bySeverity: Record<string, number> } | null;
    notes: string[];
  };
  clarifications: Clarification[];
  readiness: { ready: boolean; blockers: string[]; warnings: string[] };
  report: AssessmentReport | null;
  error?: { code: string; message: string };
  startedAt: string;
  finishedAt: string | null;
}

/* ── Self-host configuration surface (BYOK) ────────────────────────────────── */

export interface SettingsConfig {
  byok: string;
  capabilities: {
    name: string;
    mode: 'all' | 'any';
    configured: boolean;
    keys: { key: string; present: boolean; guidance: string }[];
  }[];
  deployProviders: {
    name: string;
    displayName: string;
    status: 'available' | 'stub';
    configured: boolean;
    key: string;
    guidance: string;
  }[];
}
