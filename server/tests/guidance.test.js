/**
 * The guidance engine: every issue becomes a recommendation with why + fix + tips.
 *
 * These tests pin the mapping from a signal (a failing negative test, a security
 * finding, an app that would not start) to specific, prioritised advice, and the
 * priority ordering that makes the output an action plan rather than a list.
 */
import { describe, it, expect } from 'vitest';
import { buildRecommendations, summariseRecommendations } from '../src/services/guidance.js';

const base = {
  baseUrl: 'http://127.0.0.1:5000',
  endpoints: [],
  security: { findings: [], summary: null, notes: [] },
  readiness: { ready: false, blockers: [], warnings: [] },
};

describe('buildRecommendations: testing', () => {
  it('explains a failing negative case as missing input validation', () => {
    const recs = buildRecommendations({
      assessment: { ...base, endpoints: [
        { method: 'POST', path: '/login', status: 'complete', passed: 2, failed: 1, failures: [{ category: 'negative', name: 'rejects empty body', reason: 'status: expected 400, got 200' }] },
      ] },
      model: { endpoints: [{}] },
    });
    const r = recs.find((x) => x.title.includes('accept invalid input'));
    expect(r).toBeTruthy();
    expect(r.stage).toBe('Testing');
    expect(r.why).toMatch(/did not get a 4xx/i);
    expect(r.fix).toMatch(/validate/i);
    expect(r.tips.length).toBeGreaterThan(0);
    expect(r.where).toContain('POST /login');
  });

  it('flags a failing positive case as a broken happy path, at critical priority', () => {
    const recs = buildRecommendations({
      assessment: { ...base, endpoints: [
        { method: 'GET', path: '/users/:id', status: 'complete', passed: 0, failed: 2, failures: [{ category: 'positive', name: 'returns the user', reason: 'status: expected 200, got 500' }] },
      ] },
      model: { endpoints: [{}] },
    });
    const r = recs.find((x) => x.title.includes('happy path'));
    expect(r.priority).toBe(1);
  });
});

describe('buildRecommendations: security', () => {
  it('gives why, fix and tips for a security finding, grouping occurrences', () => {
    const recs = buildRecommendations({
      assessment: { ...base, security: { findings: [
        { category: 'sql-injection', severity: 'high', title: 'Possible SQL injection', remediation: 'Use parameterised queries.', location: { file: 'a.js', line: 3 } },
        { category: 'sql-injection', severity: 'high', title: 'Possible SQL injection', remediation: 'Use parameterised queries.', location: { file: 'b.js', line: 9 } },
      ], summary: null, notes: [] } },
      model: { endpoints: [{}] },
    });
    const r = recs.find((x) => x.stage === 'Security');
    expect(r.title).toMatch(/2 occurrences/);
    expect(r.why).toMatch(/crafted value can change the query/i);
    expect(r.where).toEqual(['a.js:3', 'b.js:9']);
  });

  it('handles a hardcoded-secret category with rotation guidance', () => {
    const recs = buildRecommendations({
      assessment: { ...base, security: { findings: [
        { category: 'aws-access-key', severity: 'critical', title: 'AWS access key id', remediation: '', location: { file: 'x.js', line: 1 } },
      ], summary: null, notes: [] } },
      model: { endpoints: [{}] },
    });
    const r = recs.find((x) => x.stage === 'Security');
    expect(r.priority).toBe(1);
    expect(r.fix).toMatch(/rotate/i);
  });
});

describe('buildRecommendations: discovery and deployment', () => {
  it('advises when the app could not be started', () => {
    const recs = buildRecommendations({
      assessment: { ...base, baseUrl: null, endpoints: [{ method: 'GET', path: '/x', status: 'skipped' }] },
      model: { endpoints: [{ method: 'GET', path: '/x' }] },
    });
    const r = recs.find((x) => x.title.includes('could not be started'));
    expect(r.fix).toMatch(/process\.env\.PORT/);
  });

  it('advises when no routes were discovered', () => {
    const recs = buildRecommendations({ assessment: base, model: { endpoints: [] } });
    expect(recs.find((x) => x.title.includes('No API routes'))).toBeTruthy();
  });

  it('offers operational tips when the project is ready', () => {
    const recs = buildRecommendations({
      assessment: { ...base, readiness: { ready: true, blockers: [], warnings: [] }, endpoints: [{ method: 'GET', path: '/x', status: 'complete', passed: 3, failed: 0 }] },
      model: { endpoints: [{ method: 'GET', path: '/x' }] },
    });
    const r = recs.find((x) => x.stage === 'Deployment');
    expect(r.title).toMatch(/ready to deploy/i);
  });
});

describe('ordering and summary', () => {
  it('orders by priority so the plan leads with the most severe', () => {
    const recs = buildRecommendations({
      assessment: { ...base,
        endpoints: [{ method: 'POST', path: '/a', status: 'complete', failed: 1, failures: [{ category: 'positive' }] }],
        security: { findings: [{ category: 'docker-latest', severity: 'low', title: 'Unpinned base image', remediation: 'Pin it.' }], summary: null, notes: [] },
      },
      model: { endpoints: [{}] },
    });
    expect(recs[0].priority).toBeLessThanOrEqual(recs[recs.length - 1].priority);
    expect(recs[0].priority).toBe(1); // the broken happy path leads
  });

  it('summarises counts by priority', () => {
    const recs = buildRecommendations({
      assessment: { ...base, security: { findings: [
        { category: 'sql-injection', severity: 'high', title: 'x', remediation: '' },
        { category: 'docker-latest', severity: 'low', title: 'y', remediation: '' },
      ], summary: null, notes: [] } },
      model: { endpoints: [{}] },
    });
    const s = summariseRecommendations(recs);
    expect(s.total).toBe(recs.length);
    expect(s.byPriority.high).toBeGreaterThanOrEqual(1);
  });
});
