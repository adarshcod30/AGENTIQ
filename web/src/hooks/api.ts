/**
 * Server state: TanStack Query.
 *
 * Every hook here talks to a real endpoint. There is no mock layer and no
 * fallback data: when a query has nothing, the screen renders an empty state
 * (docs/04_App_UI.md §1: "Zero is zero. Empty is empty.").
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/services/api';
import type {
  TestRun, McpTool, AuditEvent, ApiSpec, Grant, RiskClass, HealthStatus, HttpMethod, Finding,
  Deployment, DeployConfig, PreflightCheck,
  Project, Assessment, SettingsConfig,
} from '@/types';

/* ── Health ───────────────────────────────────────────────────────────────── */

export const useHealth = () => useQuery({
  queryKey: ['health'],
  queryFn: () => apiGet<HealthStatus>('/health'),
  refetchInterval: 60_000,
  retry: false,
});

/* ── MCP: the two pages that prove the claim ──────────────────────────────── */

export interface ToolRegistry {
  count: number;
  generatedFrom: string;
  note: string;
  riskClasses: {
    name: RiskClass; label: string; description: string;
    autoGranted: boolean; requiresHost: boolean; requiresConfirmation: boolean;
  }[];
  tools: McpTool[];
}

export const useTools = () => useQuery({
  queryKey: ['mcp', 'tools'],
  queryFn: () => apiGet<ToolRegistry>('/mcp/tools'),
});

export const useAudit = (filters: {
  outcome?: string; tool?: string; runId?: string; limit?: number;
} = {}) => useQuery({
  queryKey: ['mcp', 'audit', filters],
  queryFn: () => apiGet<{ total: number; count: number; events: AuditEvent[] }>('/mcp/audit', filters),
});

/* ── Grants: the server side of the permission sheet ──────────────────────── */

export const useGrants = () => useQuery({
  queryKey: ['mcp', 'grants'],
  queryFn: () => apiGet<{ sessionId: string; grants: Grant[] }>('/mcp/grants'),
});

export function useGrantHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { riskClass: RiskClass; host?: string; confirmed?: boolean }) =>
      apiPost<{ grant: Grant }>('/mcp/grants', vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'grants'] }),
  });
}

export function useRevokeGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { riskClass: RiskClass; host?: string }) =>
      apiDelete<{ revoked: number }>('/mcp/grants', vars),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'grants'] }),
  });
}

/* ── Runs ─────────────────────────────────────────────────────────────────── */

export interface StartRunInput {
  url: string;
  method: HttpMethod;
  description: string;
  count?: number;
  intendedPublic?: boolean;
  specRef?: string;
  operationIndex?: number;
}

export function useStartRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartRunInput) => apiPost<{ run: TestRun }>('/runs', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'audit'] });
    },
  });
}

export const useRuns = (limit = 50) => useQuery({
  queryKey: ['runs', limit],
  queryFn: () => apiGet<{ total: number; count: number; runs: TestRun[] }>('/runs', { limit }),
});

export const useRun = (id: string | undefined) => useQuery({
  queryKey: ['runs', id],
  queryFn: () => apiGet<{ run: TestRun }>(`/runs/${id}`),
  enabled: Boolean(id),
});

/* ── Dashboard stats ──────────────────────────────────────────────────────── */

export interface DashboardStats {
  totals: {
    totalRuns: number; completedRuns: number; failedRuns: number;
    testsExecuted: number; testsPassed: number; testsFailed: number; discarded: number;
    passRate: number | null; medianLatencyMs: number | null;
    tokensUsed: number; costUsd: number;
  };
  findings: { critical: number; high: number; medium: number; low: number };
  totalFindings: number;
  pulse: { date: string; passed: number; failed: number; runs: number }[];
  audit: Record<string, number>;
  recent: {
    id: string; url: string; method: HttpMethod; state: string;
    passed: number; totalTests: number; findings: number; startedAt: string;
  }[];
}

export const useStats = () => useQuery({
  queryKey: ['runs', 'stats'],
  queryFn: () => apiGet<DashboardStats>('/runs/stats'),
});

/* ── Security scan ────────────────────────────────────────────────────────── */

export interface ScanResult {
  families: { family: string; owasp: string; checked: number; findings: Finding[]; note?: string; error?: string }[];
  findings: Finding[];
  summary: {
    familiesRun: number; familiesClean: number; familiesErrored: number;
    totalFindings: number; bySeverity: Record<string, number>; disclaimer: string;
  };
  needsGrant: boolean;
}

export function useScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      url: string; method: HttpMethod; intendedPublic: boolean;
      headers?: Record<string, string>;
    }) => apiPost<ScanResult>('/security/scan', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'audit'] }),
  });
}

/* ── Specs ────────────────────────────────────────────────────────────────── */

export const useSpecs = () => useQuery({
  queryKey: ['specs'],
  queryFn: () => apiGet<{ total: number; specs: ApiSpec[] }>('/specs'),
});

export const useSpec = (id: string | undefined) => useQuery({
  queryKey: ['specs', id],
  queryFn: () => apiGet<{ spec: ApiSpec }>(`/specs/${id}`),
  enabled: Boolean(id),
});

export function useImportSpec() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { url: string } | { spec: string; filename?: string }) =>
      apiPost<{ spec: ApiSpec; warnings: string[] }>('/specs/import', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['specs'] }),
  });
}

/* ── Ad-hoc request (API client, F8) ──────────────────────────────────────── */

export function useSendRequest() {
  return useMutation({
    mutationFn: (input: {
      url: string; method: HttpMethod;
      headers?: Record<string, string>; body?: unknown;
    }) => apiPost<{
      status: number; headers: Record<string, string>;
      body: string; bytes: number; durationMs: number; ip: string;
    }>('/request/send', input),
  });
}

/* ── Deployment (F5) ──────────────────────────────────────────────────────── */

export interface DeployInput {
  provider: string;
  repo: string;
  branch: string;
  serviceName: string;
  runtime: 'node' | 'python' | 'ruby' | 'go' | 'docker';
  plan: 'free' | 'starter' | 'standard';
  region: 'oregon' | 'frankfurt' | 'singapore' | 'ohio' | 'virginia';
  buildCommand: string;
  startCommand: string;
  envVars: Record<string, string>;
  dryRun: boolean;
}

export const useDeployConfig = () => useQuery({
  queryKey: ['deployments', 'config'],
  queryFn: () => apiGet<DeployConfig>('/deployments/config'),
});

/** Read-only. Answers "would this deploy?" without consenting to a deployment. */
export function usePreflight() {
  return useMutation({
    mutationFn: (input: DeployInput) =>
      apiPost<{ checks: PreflightCheck[]; ok: boolean; needsGrant: boolean }>(
        '/deployments/preflight', input),
  });
}

export function useDeploy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeployInput) => apiPost<{ deployment: Deployment }>('/deployments', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'audit'] });
      qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });
}

export const useDeployments = (limit = 20) => useQuery({
  queryKey: ['deployments', limit],
  queryFn: () => apiGet<{ total: number; count: number; deployments: Deployment[] }>(
    '/deployments', { limit }),
});

/** Approval-gated retry of a failed deployment (config-only, per the service). */
export function useRetryDeploy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; approved: boolean; envVars: Record<string, string> }) =>
      apiPost<{ deployment: Deployment }>(`/deployments/${vars.id}/retry`, {
        approved: vars.approved, envVars: vars.envVars,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments'] });
      qc.invalidateQueries({ queryKey: ['mcp', 'audit'] });
    },
  });
}

/* ── Projects and assessments (autonomous platform) ───────────────────────── */

export const useProjects = () => useQuery({
  queryKey: ['projects'],
  queryFn: () => apiGet<{ projects: Project[] }>('/projects'),
  // While a GitHub repo is cloning in the background, poll so the status flips to
  // ready (or failed) on its own, without the user refreshing.
  refetchInterval: (query) => (
    query.state.data?.projects?.some((p) => p.cloneStatus === 'cloning') ? 2000 : false
  ),
});

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string; workspaceRoot?: string; targetUrl?: string; repoUrl?: string;
      runtimeEnv?: Record<string, string>; startScript?: string;
    }) => apiPost<{ project: Project }>('/projects', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/** Set (or clear) a project's opt-in runtime env. Values go up; only keys come back. */
export function useUpdateProjectEnv() {
  const qc = useQueryClient();
  return useMutation({
    // Each field is sent only when provided, so saving env does not clear the
    // start script and vice versa. An empty startScript string clears it.
    mutationFn: (vars: { id: string; runtimeEnv?: Record<string, string>; startScript?: string; targetUrl?: string }) =>
      apiPatch<{ id: string; runtimeEnvKeys: string[]; startScript: string | null; targetUrl: string | null }>(
        `/projects/${vars.id}/env`,
        {
          ...(vars.runtimeEnv !== undefined ? { runtimeEnv: vars.runtimeEnv } : {}),
          ...(vars.startScript !== undefined ? { startScript: vars.startScript } : {}),
          ...(vars.targetUrl !== undefined ? { targetUrl: vars.targetUrl } : {}),
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/** Load a project's runtime env from its own .env file. The server reads the
 *  file through the jail; only the key names come back, never the values. */
export function useImportProjectEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      apiPost<{ id: string; runtimeEnvKeys: string[]; imported: number }>(`/projects/${vars.id}/env/from-file`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

export const useAssessments = (projectId?: string) => useQuery({
  queryKey: ['assessments', { projectId: projectId ?? null }],
  queryFn: () => apiGet<{ assessments: Assessment[] }>('/assessments', projectId ? { projectId } : undefined),
});

export function useCreateAssessment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { projectId: string; pauseOnClarification?: boolean }) =>
      apiPost<{ assessment: Assessment }>('/assessments', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assessments'] }),
  });
}

/** A live phase timeline: poll while the assessment is still running. */
export const useAssessment = (id: string | undefined) => useQuery({
  queryKey: ['assessments', id],
  queryFn: () => apiGet<{ assessment: Assessment }>(`/assessments/${id}`),
  enabled: Boolean(id),
  refetchInterval: (query) => {
    const state = query.state.data?.assessment?.state;
    const done = state === 'COMPLETE' || state === 'FAILED' || state === 'AWAITING_INPUT';
    return done ? false : 1500;
  },
});

export function useAnswerClarification(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { endpoint: string; answer: string }) =>
      apiPost<{ assessment: Assessment }>(`/assessments/${id}/answer`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assessments', id] }),
  });
}

/** Fetches the rendered Markdown report and triggers a browser download. */
export async function downloadAssessmentReport(id: string) {
  const { markdown, filename } = await apiGet<{ markdown: string; filename: string }>(`/assessments/${id}/report`);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ── Self-host configuration (BYOK) ───────────────────────────────────────── */

export const useSettingsConfig = () => useQuery({
  queryKey: ['settings', 'config'],
  queryFn: () => apiGet<SettingsConfig>('/settings/config'),
});
