/**
 * The assessment orchestrator: discover, test, scan, analyze, report.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §C, §F, Phase 4. This drives one autonomous run
 * over a project, persisting every phase transition so a client sees a live
 * timeline and a killed job resumes from where it stopped. The route enqueues a
 * job and returns; this runs in a worker.
 *
 * The phase functions take a `deps` object so tests can drive the whole state
 * machine with stubs, no real app, tools or LLM. The defaults wire the real
 * discovery agent, intent agent, testing agent and security assessment.
 */
import { createJail } from '../mcp/fsJail.js';
import { getTool } from '../mcp/registry.js';
import { grantStore, RISK_CLASS } from '../mcp/permissions.js';
import { runDiscoveryAgent } from '../agents/discovery.agent.js';
import { inferEndpointIntent, needsClarification } from '../agents/intent.agent.js';
import { runTestingAgentForEndpoint } from '../agents/testing.agent.js';
import { runSecurityAssessment } from '../agents/security.agent.js';
import { Assessment, ASSESS_STATE, canTransition } from '../models/Assessment.js';
import { Discovery } from '../models/Discovery.js';
import { Project } from '../models/Project.js';
import { assessmentQueue } from '../lib/jobQueue.js';
import { buildReport, computeReadiness } from './report.service.js';
import { logger } from '../lib/logger.js';

export class AssessmentError extends Error {
  constructor(message, code = 'ASSESSMENT_ERROR', status = 400) {
    super(message);
    this.name = 'AssessmentError';
    this.code = code;
    this.status = status;
  }
}

/** How many endpoints to test in one assessment, to bound cost and time. */
const MAX_ENDPOINTS = 25;

const S = ASSESS_STATE;
const ORDER = [S.PENDING, S.DISCOVERING, S.TESTING, S.SCANNING, S.ANALYZING, S.REPORTING, S.COMPLETE];
const before = (state, target) => ORDER.indexOf(state) < ORDER.indexOf(target);

async function transition(assessment, next, note) {
  if (!canTransition(assessment.state, next)) {
    throw new AssessmentError(`Illegal transition ${assessment.state} -> ${next}`, 'ILLEGAL_TRANSITION', 500);
  }
  assessment.state = next;
  assessment.stateHistory.push({ state: next, at: new Date(), note });
  await assessment.save();
  return assessment;
}

/** The real tool runner in the assessment's workspace context. */
function makeRunTool(context) {
  return (name, input, extra = {}) => getTool(name).handler(input, { ...context, ...extra });
}

/** Default phase implementations; tests override any of these. */
export function defaultDeps() {
  return {
    discover: ({ runTool, context }) => runDiscoveryAgent({ runTool, context }),
    inferIntent: ({ endpoint, source }) => inferEndpointIntent({ endpoint, source }).catch(() => null),
    testEndpoint: (args) => runTestingAgentForEndpoint(args),
    securityAssess: (args) => runSecurityAssessment(args),
    ensureApp: defaultEnsureApp,
    stopApp: async (runTool, context) => runTool('app_lifecycle', { action: 'stop' }, context).catch(() => {}),
  };
}

/**
 * Starts the app if the project has a start script, and returns its base URL,
 * or null when there is nothing to start. Grants network.read for the app host
 * so the testing tools may reach it: the user consented to the assessment, and
 * the target is the app the platform itself just started on loopback.
 */
async function defaultEnsureApp({ runTool, context, scripts, userId, sessionId }) {
  const script = ['dev', 'start', 'serve'].find((s) => scripts?.[s]);
  if (!script) return { baseUrl: null, note: 'No dev/start/serve script; the app was not started.' };
  const status = await runTool('app_lifecycle', { action: 'status' }, context);
  const started = status.running ? status : await runTool('app_lifecycle', { action: 'start', runner: 'npm', script }, context);
  const host = new URL(started.baseUrl).host;
  grantStore.grant({ userId, sessionId, riskClass: RISK_CLASS.NETWORK_READ, host });
  return { baseUrl: started.baseUrl, note: null };
}

// ── Phases ───────────────────────────────────────────────────────────────────

async function phaseDiscover(assessment, project, ctx, deps) {
  await transition(assessment, S.DISCOVERING, 'building the project model');
  const model = await deps.discover({ runTool: ctx.runTool, context: ctx.context });
  const discovery = await Discovery.create({ projectId: project._id, userId: assessment.userId, ...model });
  assessment.discoveryId = discovery._id;
  project.lastDiscoveryAt = new Date();
  await project.save();
  await assessment.save();
  return { model, discovery };
}

async function phaseTest(assessment, model, ctx, deps, { pauseOnClarification }) {
  await transition(assessment, S.TESTING, 'starting the app and testing endpoints');

  const app = await deps.ensureApp({
    runTool: ctx.runTool, context: ctx.context, scripts: model.scripts,
    userId: String(assessment.userId), sessionId: ctx.sessionId,
  });
  assessment.baseUrl = app.baseUrl;
  if (app.note) assessment.security.notes.push(app.note);
  await assessment.save();

  const endpoints = (model.endpoints ?? []).slice(0, MAX_ENDPOINTS);
  for (const endpoint of endpoints) {
    // Intent: read the endpoint's source through fs_read, then infer.
    let intent = null;
    try {
      const src = endpoint.file ? await ctx.runTool('fs_read', { path: endpoint.file }, ctx.context) : null;
      intent = await deps.inferIntent({ endpoint, source: src?.content ?? '' });
    } catch { /* intent is best-effort */ }

    if (intent && needsClarification(intent) && intent.clarification) {
      assessment.clarifications.push({ endpoint: `${endpoint.method} ${endpoint.path}`, question: intent.clarification });
      if (pauseOnClarification) {
        await assessment.save();
        await transition(assessment, S.AWAITING_INPUT, 'a clarification is needed before testing continues');
        return { paused: true };
      }
    }

    if (!app.baseUrl) {
      assessment.endpoints.push({
        method: endpoint.method, path: endpoint.path, intent: intent?.intent ?? null,
        confidence: intent?.confidence ?? null, status: 'skipped', note: 'app not started',
        passed: 0, failed: 0, errored: 0,
      });
      continue;
    }

    try {
      const result = await deps.testEndpoint({
        endpoint, baseUrl: app.baseUrl, intent: intent?.intent ?? null,
        runTool: ctx.runTool, context: ctx.context,
      });
      assessment.endpoints.push({
        method: endpoint.method, path: endpoint.path, intent: intent?.intent ?? null,
        confidence: intent?.confidence ?? null, status: 'complete',
        passed: result.summary?.passed ?? 0, failed: result.summary?.failed ?? 0,
        errored: result.summary?.errored ?? 0,
      });
    } catch (err) {
      assessment.endpoints.push({
        method: endpoint.method, path: endpoint.path, intent: intent?.intent ?? null,
        confidence: intent?.confidence ?? null, status: 'failed', note: err.message,
        passed: 0, failed: 0, errored: 0,
      });
    }
    await assessment.save();
  }
  return { paused: false };
}

async function phaseScan(assessment, model, ctx, deps) {
  await transition(assessment, S.SCANNING, 'running the security assessment');
  const security = await deps.securityAssess({
    url: assessment.baseUrl ?? null,
    method: 'GET',
    intendedPublic: false,
    runTool: ctx.runTool,
    context: ctx.context,
  });
  assessment.security.findings = security.findings;
  assessment.security.summary = security.summary;
  if (security.notes?.length) assessment.security.notes.push(...security.notes);
  await assessment.save();
}

async function phaseAnalyze(assessment) {
  await transition(assessment, S.ANALYZING, 'correlating results and judging readiness');
  assessment.readiness = computeReadiness(assessment);
  await assessment.save();
}

async function phaseReport(assessment, model) {
  await transition(assessment, S.REPORTING, 'assembling the report');
  assessment.report = buildReport(assessment, model);
  await assessment.save();
  await transition(assessment, S.COMPLETE, 'done');
  assessment.finishedAt = new Date();
  await assessment.save();
}

async function finishFailed(assessment, err) {
  logger.warn({ assessmentId: String(assessment._id), err: err.message }, 'assessment failed');
  assessment.error = { code: err.code ?? 'INTERNAL_ERROR', message: err.message };
  assessment.finishedAt = new Date();
  assessment.state = S.FAILED;
  assessment.stateHistory.push({ state: S.FAILED, at: new Date(), note: err.message });
  await assessment.save();
  return assessment;
}

/**
 * Runs (or resumes) an assessment from its current state. Idempotent per phase:
 * a phase already past is skipped, so re-triggering a killed job continues it.
 */
export async function runAssessment({ assessmentId, deps = defaultDeps(), pauseOnClarification = false } = {}) {
  const assessment = await Assessment.findById(assessmentId);
  if (!assessment) return null;
  const project = await Project.findById(assessment.projectId);
  if (!project) return finishFailed(assessment, new AssessmentError('Project gone', 'PROJECT_GONE', 409));

  let jail;
  try {
    jail = createJail(project.workspaceRoot);
  } catch {
    return finishFailed(assessment, new AssessmentError('Workspace unavailable', 'WORKSPACE_GONE', 409));
  }
  const context = { userId: String(assessment.userId), sessionId: `assessment:${assessmentId}`, workspaceRoot: jail.root };
  const ctx = { context, sessionId: context.sessionId, runTool: makeRunTool(context) };

  try {
    let model = assessment.discoveryId
      ? await Discovery.findById(assessment.discoveryId).lean()
      : null;

    if (before(assessment.state, S.TESTING)) {
      ({ model } = await phaseDiscover(assessment, project, ctx, deps));
    }
    if (before(assessment.state, S.SCANNING)) {
      const { paused } = await phaseTest(assessment, model, ctx, deps, { pauseOnClarification });
      if (paused) return assessment; // waits for an answer
    }
    if (before(assessment.state, S.ANALYZING)) await phaseScan(assessment, model, ctx, deps);
    if (before(assessment.state, S.REPORTING)) await phaseAnalyze(assessment);
    if (before(assessment.state, S.COMPLETE)) await phaseReport(assessment, model);

    await deps.stopApp(ctx.runTool, context);
    return assessment;
  } catch (err) {
    await deps.stopApp(ctx.runTool, context).catch(() => {});
    return finishFailed(assessment, err);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Creates an assessment and schedules it. Returns immediately. */
export async function createAssessment({ userId, projectId, pauseOnClarification = false, schedule = true }) {
  const project = await Project.findOne({ _id: projectId, userId });
  if (!project) throw new AssessmentError('Project not found', 'NOT_FOUND', 404);

  const assessment = await Assessment.create({
    userId, projectId, state: S.PENDING,
    stateHistory: [{ state: S.PENDING, at: new Date() }],
  });
  if (schedule) {
    assessmentQueue.enqueue(() => runAssessment({ assessmentId: assessment._id, pauseOnClarification })
      .catch((err) => logger.error({ err: err.message }, 'assessment job crashed')));
  }
  return assessment;
}

export async function listAssessments({ userId, projectId = null }) {
  const q = { userId };
  if (projectId) q.projectId = projectId;
  return Assessment.find(q).sort({ createdAt: -1 }).limit(100).lean();
}

export async function getAssessment({ userId, assessmentId }) {
  return Assessment.findOne({ _id: assessmentId, userId }).lean();
}

/** Records a clarification answer and resumes a paused assessment. */
export async function answerClarification({ userId, assessmentId, endpoint, answer }) {
  const assessment = await Assessment.findOne({ _id: assessmentId, userId });
  if (!assessment) throw new AssessmentError('Assessment not found', 'NOT_FOUND', 404);
  const c = assessment.clarifications.find((x) => x.endpoint === endpoint && !x.answer);
  if (c) c.answer = answer;
  await assessment.save();

  if (assessment.state === S.AWAITING_INPUT) {
    // Move back to TESTING so the pipeline continues, then re-schedule.
    await transition(assessment, S.TESTING, 'clarification answered, resuming');
    assessmentQueue.enqueue(() => runAssessment({ assessmentId })
      .catch((err) => logger.error({ err: err.message }, 'resume crashed')));
  }
  return assessment;
}

export default { createAssessment, runAssessment, listAssessments, getAssessment, answerClarification };
