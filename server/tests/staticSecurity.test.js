/**
 * The static security lanes: findings model, secrets, source, config, deps.
 * All pure, so no workspace, network or npm is needed.
 */
import { describe, it, expect } from 'vitest';
import {
  makeFinding, dedupeFindings, correlateFindings, rankFindings, countBySeverity,
  SEVERITY, CONFIDENCE, LANE,
} from '../src/mcp/analysis/findings.js';
import { scanSecrets, mask } from '../src/mcp/analysis/secretScan.js';
import { scanSource } from '../src/mcp/analysis/sastScan.js';
import { scanAppConfig, scanCommittedEnv, scanDockerfile } from '../src/mcp/analysis/configScan.js';
import { parseNpmAudit } from '../src/mcp/analysis/depAudit.js';

describe('findings model', () => {
  it('dedupes identical findings, keeping the stronger severity', () => {
    const f = (sev) => makeFinding({ lane: LANE.SAST, category: 'x', severity: sev, confidence: CONFIDENCE.POTENTIAL, title: 't', location: { file: 'a.js', line: 1 } });
    const out = dedupeFindings([f(SEVERITY.LOW), f(SEVERITY.HIGH)]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('high');
  });

  it('correlates a static and a dynamic finding at the same endpoint into one', () => {
    const dast = makeFinding({ lane: LANE.DAST, category: 'broken-auth', severity: SEVERITY.HIGH, confidence: CONFIDENCE.CONFIRMED, title: 'DAST', evidence: 'anon 200', location: { endpoint: 'GET /admin' } });
    const sast = makeFinding({ lane: LANE.SAST, category: 'broken-auth', severity: SEVERITY.MEDIUM, confidence: CONFIDENCE.POTENTIAL, title: 'SAST', evidence: 'no auth check', location: { endpoint: 'GET /admin' } });
    const out = correlateFindings([dast, sast]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('high');
    expect(out[0].confidence).toBe('confirmed');
    expect(out[0].lane).toContain('dast');
    expect(out[0].evidence).toContain('[sast]');
  });

  it('ranks most severe first and counts by severity', () => {
    const findings = [
      makeFinding({ lane: 'x', category: 'a', severity: SEVERITY.LOW, confidence: CONFIDENCE.POTENTIAL, title: 'a' }),
      makeFinding({ lane: 'x', category: 'b', severity: SEVERITY.CRITICAL, confidence: CONFIDENCE.CONFIRMED, title: 'b' }),
    ];
    expect(rankFindings(findings)[0].severity).toBe('critical');
    expect(countBySeverity(findings)).toMatchObject({ critical: 1, low: 1 });
  });
});

describe('secret scan', () => {
  it('detects provider keys, private keys and inline db passwords', () => {
    const files = [
      { path: 'config.js', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\nconst g = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe";' },
      { path: 'db.js', content: 'const uri = "mongodb+srv://user:hunter2pass@cluster.x.net/db";' },
      { path: 'key.pem', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----' },
    ];
    const cats = scanSecrets(files).map((f) => f.category);
    expect(cats).toContain('aws-access-key');
    expect(cats).toContain('google-api-key');
    expect(cats).toContain('mongo-uri-with-password');
    expect(cats).toContain('private-key');
  });

  it('flags a hardcoded assignment but not a placeholder or an env read', () => {
    const files = [{ path: 'a.js', content: 'const password = "s3cr3tValue99";\nconst p2 = "changeme";\nconst p3 = process.env.PASSWORD;' }];
    const found = scanSecrets(files);
    expect(found).toHaveLength(1);
    expect(found[0].category).toBe('assigned-secret');
  });

  it('skips .env.example and masks the secret in the evidence', () => {
    expect(scanSecrets([{ path: '.env.example', content: 'AWS=AKIAIOSFODNN7EXAMPLE' }])).toEqual([]);
    expect(mask('AKIAIOSFODNN7EXAMPLE')).toBe('AK***LE');
  });
});

describe('SAST scan', () => {
  it('flags injection, command execution, eval, traversal and weak hashing', () => {
    const files = [{
      path: 'h.js',
      content: [
        'db.query(`SELECT * FROM u WHERE id = ${req.params.id}`)',
        'exec(`rm -rf ${dir}`)',
        'eval(userInput)',
        'fs.readFileSync(req.query.path)',
        'crypto.createHash("md5")',
      ].join('\n'),
    }];
    const cats = scanSource(files).map((f) => f.category);
    expect(cats).toContain('sql-injection');
    expect(cats).toContain('command-injection');
    expect(cats).toContain('code-eval');
    expect(cats).toContain('path-traversal');
    expect(cats).toContain('weak-hash');
  });

  it('marks static findings as potential, not confirmed', () => {
    const found = scanSource([{ path: 'h.js', content: 'eval(x)' }]);
    expect(found[0].confidence).toBe('potential');
  });
});

describe('config scan', () => {
  it('flags an express app without helmet', () => {
    const cats = scanAppConfig([{ path: 'app.js', content: 'const express = require("express"); const app = express();' }]).map((f) => f.category);
    expect(cats).toContain('missing-security-headers');
  });

  it('flags CORS reflecting origin with credentials', () => {
    const cats = scanAppConfig([{ path: 'app.js', content: 'app.use(cors({ origin: true, credentials: true }))' }]).map((f) => f.category);
    expect(cats).toContain('cors-permissive');
  });

  it('flags a committed .env but not .env.example', () => {
    expect(scanCommittedEnv(['.env', '.env.example', 'src/a.js']).map((f) => f.category)).toEqual(['committed-env']);
  });

  it('flags a Dockerfile that runs as root', () => {
    const cats = scanDockerfile('Dockerfile', 'FROM node:22\nCMD ["node","x.js"]').map((f) => f.category);
    expect(cats).toContain('docker-root');
  });
});

describe('dep audit parser', () => {
  it('normalises npm audit JSON into findings', () => {
    const audit = {
      vulnerabilities: {
        lodash: { name: 'lodash', severity: 'high', range: '<4.17.21', via: [{ title: 'Prototype Pollution' }], fixAvailable: true },
        minimist: { name: 'minimist', severity: 'moderate', range: '<1.2.6', via: [{ title: 'ReDoS' }], fixAvailable: { name: 'minimist', version: '1.2.8' } },
      },
      metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 } },
    };
    const { findings, summary } = parseNpmAudit(audit);
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.title.startsWith('lodash')).severity).toBe('high');
    expect(findings.find((f) => f.title.startsWith('minimist')).severity).toBe('medium');
    expect(summary.total).toBe(2);
  });

  it('returns an empty result for malformed input, never throws', () => {
    expect(parseNpmAudit(null).findings).toEqual([]);
    expect(parseNpmAudit({}).findings).toEqual([]);
  });
});
