/**
 * Phase 7 acceptance: two projects assessed concurrently do not see each other's
 * workspace, grants or findings.
 *
 * This is the isolation guarantee the whole hardening phase exists to make true.
 * It runs two assessments over two different workspace roots at the same time
 * (Promise.all, so they interleave at every await), with deps that capture the
 * context each phase was handed. If the orchestrator ever built its context from
 * shared mutable state, one run would see the other's workspace root, session or
 * findings, and one of these assertions would fail.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { Assessment } from '../src/models/Assessment.js';
import { Discovery } from '../src/models/Discovery.js';
import { runAssessment, createAssessment } from '../src/services/assessment.service.js';
import { grantStore, RISK_CLASS } from '../src/mcp/permissions.js';

let userId;
let rootA;
let rootB;

/**
 * Deps that tag everything they produce with the workspace root they ran in, and
 * grant network.read for a per-project host, so a leak between the two runs shows
 * up as a wrong tag or a grant readable from the wrong session.
 */
function taggedDeps(hostForRoot) {
  const seen = [];
  const deps = {
    discover: async ({ context }) => {
      seen.push({ phase: 'discover', root: context.workspaceRoot, session: context.sessionId });
      return {
        framework: 'express', endpointCount: 0, endpoints: [],
        dependencies: [], scripts: {}, config: {}, stats: {},
      };
    },
    inferIntent: async () => null,
    testEndpoint: async () => ({ summary: { passed: 0, failed: 0, errored: 0 } }),
    ensureApp: async ({ context, userId: uid, sessionId }) => {
      const host = hostForRoot(context.workspaceRoot);
      grantStore.grant({ userId: uid, sessionId, riskClass: RISK_CLASS.NETWORK_READ, host });
      return { baseUrl: `http://${host}`, note: null };
    },
    securityAssess: async ({ context }) => {
      seen.push({ phase: 'scan', root: context.workspaceRoot, session: context.sessionId });
      // The finding's evidence is the root, so a crossed finding is visible.
      return {
        findings: [{
          lane: 'sast', category: 'marker', severity: 'low', confidence: 'informational',
          title: 'root marker', description: '', evidence: context.workspaceRoot,
          remediation: '', owasp: null, location: { file: null, line: null, endpoint: null },
        }],
        summary: { total: 1, bySeverity: { critical: 0, high: 0, medium: 0, low: 1, info: 0 } },
        notes: [],
      };
    },
    stopApp: async () => {},
  };
  return { deps, seen };
}

beforeAll(async () => {
  await connectTestDb();
  // realpath because the fs jail stores the resolved root: on macOS tmpdir is a
  // symlink (/var -> /private/var), so the jail root would not equal the raw
  // mkdtemp path. Resolving here keeps every comparison in the same frame.
  rootA = realpathSync(mkdtempSync(path.join(tmpdir(), 'proj-a-')));
  rootB = realpathSync(mkdtempSync(path.join(tmpdir(), 'proj-b-')));
});

afterAll(async () => {
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
  await disconnectTestDb();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Project.deleteMany({}), Assessment.deleteMany({}), Discovery.deleteMany({})]);
  grantStore.clear();
  const u = await User.create({ email: 'iso@example.com', displayName: 'Iso', authProviders: [{ provider: 'local', providerId: 'iso@example.com', email: 'iso@example.com' }] });
  userId = u._id;
});

describe('concurrent assessment isolation', () => {
  it('two projects assessed at once keep separate workspaces, grants and findings', async () => {
    const projA = await Project.create({ userId, name: 'A', workspaceRoot: rootA });
    const projB = await Project.create({ userId, name: 'B', workspaceRoot: rootB });
    const a = await createAssessment({ userId, projectId: projA._id, schedule: false });
    const b = await createAssessment({ userId, projectId: projB._id, schedule: false });

    // A distinct host per project, derived from its root, so grants are checkable.
    const hostA = '127.0.0.1:5551';
    const hostB = '127.0.0.1:5552';
    const hostForRoot = (root) => (root === rootA ? hostA : hostB);
    const A = taggedDeps(hostForRoot);
    const B = taggedDeps(hostForRoot);

    // Run both at the same time.
    const [doneA, doneB] = await Promise.all([
      runAssessment({ assessmentId: a._id, deps: A.deps }),
      runAssessment({ assessmentId: b._id, deps: B.deps }),
    ]);

    // Workspace: every phase of each run saw only its own root.
    expect(A.seen.every((s) => s.root === rootA)).toBe(true);
    expect(B.seen.every((s) => s.root === rootB)).toBe(true);

    // Session: distinct, and tied to the assessment id.
    expect(A.seen.every((s) => s.session === `assessment:${a._id}`)).toBe(true);
    expect(B.seen.every((s) => s.session === `assessment:${b._id}`)).toBe(true);

    // Findings: each assessment's stored finding points at its own root, never the other's.
    expect(doneA.security.findings).toHaveLength(1);
    expect(doneA.security.findings[0].evidence).toBe(rootA);
    expect(doneB.security.findings[0].evidence).toBe(rootB);

    // Grants: A's host is granted to A's session and denied to B's, and vice versa.
    const sessA = `assessment:${a._id}`;
    const sessB = `assessment:${b._id}`;
    const uid = String(userId);
    expect(grantStore.check({ userId: uid, sessionId: sessA, riskClass: RISK_CLASS.NETWORK_READ, host: hostA }).allowed).toBe(true);
    expect(grantStore.check({ userId: uid, sessionId: sessB, riskClass: RISK_CLASS.NETWORK_READ, host: hostA }).allowed).toBe(false);
    expect(grantStore.check({ userId: uid, sessionId: sessB, riskClass: RISK_CLASS.NETWORK_READ, host: hostB }).allowed).toBe(true);
    expect(grantStore.check({ userId: uid, sessionId: sessA, riskClass: RISK_CLASS.NETWORK_READ, host: hostB }).allowed).toBe(false);
  });
});
