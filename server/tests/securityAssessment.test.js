/**
 * The unified security assessment: DAST mapping, static lanes, correlation.
 * The tools are stubbed, so no workspace or running app is needed here.
 */
import { describe, it, expect } from 'vitest';
import {
  dastToFinding, runStaticSecurity, runSecurityAssessment,
} from '../src/agents/security.agent.js';
import { makeFinding, SEVERITY, CONFIDENCE, LANE } from '../src/mcp/analysis/findings.js';

describe('dastToFinding', () => {
  it('maps a probe finding to the shared shape as confirmed', () => {
    const probe = {
      family: 'sqli', owasp: 'API8:2023', severity: SEVERITY.HIGH,
      payload: "1' OR '1'='1", signal: 'DB error appeared',
      explanation: 'The endpoint is injectable. An attacker can read the database.',
      remediation: 'Use parameterised queries.',
    };
    const f = dastToFinding(probe, { endpoint: 'GET /search' });
    expect(f.lane).toBe('dast');
    expect(f.confidence).toBe('confirmed');
    expect(f.category).toBe('sqli');
    expect(f.location.endpoint).toBe('GET /search');
    expect(f.evidence).toContain("1' OR");
  });
});

describe('runStaticSecurity', () => {
  it('aggregates findings and notes across the four lanes', async () => {
    const byTool = {
      secret_scan: { findings: [makeFinding({ lane: LANE.SECRETS, category: 'aws-access-key', severity: SEVERITY.CRITICAL, confidence: CONFIDENCE.STRONG, title: 'k' })] },
      sast_scan: { findings: [makeFinding({ lane: LANE.SAST, category: 'code-eval', severity: SEVERITY.HIGH, confidence: CONFIDENCE.POTENTIAL, title: 'e' })] },
      config_scan: { findings: [] },
      dep_audit: { findings: [], note: 'no lockfile' },
    };
    const runTool = async (name) => byTool[name];
    const out = await runStaticSecurity({ runTool });
    expect(out.findings).toHaveLength(2);
    expect(out.notes).toContain('dep_audit: no lockfile');
  });

  it('does not abandon the lane sweep when one tool throws', async () => {
    const runTool = async (name) => {
      if (name === 'sast_scan') throw new Error('boom');
      return { findings: [] };
    };
    const out = await runStaticSecurity({ runTool });
    expect(out.notes.some((n) => n.includes('sast_scan failed'))).toBe(true);
  });
});

describe('runSecurityAssessment (static only, no running app)', () => {
  it('ranks findings most-severe first and reports lane counts', async () => {
    const runTool = async (name) => {
      if (name === 'secret_scan') {
        return { findings: [makeFinding({ lane: LANE.SECRETS, category: 'aws-access-key', severity: SEVERITY.CRITICAL, confidence: CONFIDENCE.STRONG, title: 'crit' })] };
      }
      if (name === 'sast_scan') {
        return { findings: [makeFinding({ lane: LANE.SAST, category: 'weak-hash', severity: SEVERITY.LOW, confidence: CONFIDENCE.POTENTIAL, title: 'low' })] };
      }
      return { findings: [] };
    };
    const out = await runSecurityAssessment({ url: null, runTool });
    expect(out.findings[0].severity).toBe('critical');
    expect(out.summary.lanes.static).toBe(2);
    expect(out.summary.lanes.dast).toBe(0);
    expect(out.summary.disclaimer).toContain('not a guarantee of security');
  });
});
