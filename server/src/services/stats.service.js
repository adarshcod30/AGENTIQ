/**
 * Dashboard aggregates: docs/01_PRD.md F6.
 *
 * Every figure below is an aggregation pipeline you can run yourself in a Mongo
 * shell, scoped to one user. No number on the dashboard is a literal in the
 * component tree.
 *
 * A NEW ACCOUNT RETURNS HONEST ZEROS. Nothing here invents a data point to
 * make a chart look alive (docs/01_PRD.md F6 acceptance criterion).
 */
import { TestRun } from '../models/TestRun.js';
import { AuditEvent } from '../models/AuditEvent.js';

/** Days of history shown by the pass/fail series. */
export const PULSE_DAYS = 14;

/** YYYY-MM-DD in UTC, so bucket keys are stable regardless of server timezone. */
function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Builds the full 14-day window including days with NO runs.
 *
 * A $group alone returns only days that have data, and a chart drawn from that
 * silently compresses gaps: three runs across two weeks would look like three
 * consecutive busy days. Zero-filling keeps the x-axis honest.
 */
function emptyPulse(days = PULSE_DAYS, now = new Date()) {
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    series.push({ date: dayKey(d), passed: 0, failed: 0, runs: 0 });
  }
  return series;
}

export async function getStats({ userId, now = new Date() }) {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - (PULSE_DAYS - 1));
  since.setUTCHours(0, 0, 0, 0);

  const [totals, pulseRows, severity, recent, auditTotals] = await Promise.all([
    // ── Headline counters ────────────────────────────────────────────────
    TestRun.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          totalRuns: { $sum: 1 },
          completedRuns: { $sum: { $cond: [{ $eq: ['$state', 'COMPLETE'] }, 1, 0] } },
          failedRuns: { $sum: { $cond: [{ $in: ['$state', ['GEN_FAILED', 'EXEC_FAILED']] }, 1, 0] } },
          testsExecuted: { $sum: '$summary.totalTests' },
          testsPassed: { $sum: '$summary.passed' },
          testsFailed: { $sum: '$summary.failed' },
          discarded: { $sum: '$summary.discarded' },
          inputTokens: { $sum: '$generation.inputTokens' },
          outputTokens: { $sum: '$generation.outputTokens' },
          costUsd: { $sum: { $ifNull: ['$generation.costUsd', 0] } },
        },
      },
    ]),

    // ── 14-day pass/fail series ──────────────────────────────────────────
    TestRun.aggregate([
      { $match: { userId, startedAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: 'UTC' } },
          passed: { $sum: '$summary.passed' },
          failed: { $sum: '$summary.failed' },
          runs: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),

    // ── Findings by severity, across every run ───────────────────────────
    TestRun.aggregate([
      { $match: { userId } },
      { $unwind: { path: '$security', preserveNullAndEmptyArrays: false } },
      { $group: { _id: '$security.severity', count: { $sum: 1 } } },
    ]),

    TestRun.find({ userId })
      .sort({ startedAt: -1 }).limit(5)
      .select('target state summary startedAt finishedAt security')
      .lean(),

    // Audit counts prove the tool layer is live, on the dashboard itself.
    AuditEvent.aggregate([
      { $match: { userId } },
      { $group: { _id: '$outcome', count: { $sum: 1 } } },
    ]),
  ]);

  const t = totals[0] ?? {};
  const testsExecuted = t.testsExecuted ?? 0;
  const testsPassed = t.testsPassed ?? 0;

  // Median latency across executed cases. Computed in JS rather than a
  // pipeline because $median needs a version floor we do not want to require,
  // and the result set here is small by construction.
  const durations = await TestRun.aggregate([
    { $match: { userId } },
    { $unwind: '$functional' },
    { $project: { ms: '$functional.responseTimeMs' } },
    { $sort: { ms: 1 } },
  ]);
  const medianLatencyMs = durations.length
    ? durations[Math.floor(durations.length / 2)].ms
    : null;

  const pulse = emptyPulse(PULSE_DAYS, now);
  const byDate = new Map(pulseRows.map((r) => [r._id, r]));
  for (const day of pulse) {
    const row = byDate.get(day.date);
    if (row) Object.assign(day, { passed: row.passed, failed: row.failed, runs: row.runs });
  }

  const findings = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const row of severity) {
    if (row._id in findings) findings[row._id] = row.count;
  }

  const audit = { ok: 0, denied: 0, blocked_ssrf: 0, rate_limited: 0, error: 0 };
  for (const row of auditTotals) {
    if (row._id in audit) audit[row._id] = row.count;
  }

  return {
    totals: {
      totalRuns: t.totalRuns ?? 0,
      completedRuns: t.completedRuns ?? 0,
      failedRuns: t.failedRuns ?? 0,
      testsExecuted,
      testsPassed,
      testsFailed: t.testsFailed ?? 0,
      discarded: t.discarded ?? 0,
      // null, not 0, when nothing has run: "no data" is not "0% pass rate".
      passRate: testsExecuted > 0 ? Math.round((testsPassed / testsExecuted) * 1000) / 10 : null,
      medianLatencyMs,
      tokensUsed: (t.inputTokens ?? 0) + (t.outputTokens ?? 0),
      costUsd: Math.round((t.costUsd ?? 0) * 10000) / 10000,
    },
    findings,
    totalFindings: Object.values(findings).reduce((a, b) => a + b, 0),
    pulse,
    audit,
    recent: recent.map((r) => ({
      id: String(r._id),
      url: r.target?.url ?? '',
      method: r.target?.method ?? 'GET',
      state: r.state,
      passed: r.summary?.passed ?? 0,
      totalTests: r.summary?.totalTests ?? 0,
      findings: r.security?.length ?? 0,
      startedAt: r.startedAt,
    })),
  };
}

export default { getStats, PULSE_DAYS };
