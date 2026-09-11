/**
 * ACCEPTANCE CRITERIA, docs/01_PRD.md F3:
 *
 *   >= 5 of 6 families detected on vulnerable-api
 *   ZERO findings on hardened-api
 *   every finding carries payload + signal + baseline
 *
 * Both fixtures serve an identical contract (fixtures/README.md), so a finding
 * on one and not the other cannot be explained by anything except the defect.
 * That is what makes these numbers mean something.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectTestDb, disconnectTestDb } from './helpers/mongo.js';
import { runSecurityAgent, FAMILIES, countBySeverity } from '../src/agents/security.agent.js';
import { registerAllTools } from '../src/mcp/tools/index.js';
import { getTool } from '../src/mcp/registry.js';
import { grantStore, RISK_CLASS } from '../src/mcp/permissions.js';
import { AuditEvent } from '../src/models/AuditEvent.js';
import { findDbError, SQLI_PAYLOADS, DESTRUCTIVE, bodyToText } from '../src/mcp/probes/fingerprints.js';
import { compare, captureBaseline, baselineIsBroken } from '../src/mcp/probes/baseline.js';
import { stripCredentials } from '../src/mcp/tools/probe_auth.js';
import { env } from '../src/config/env.js';
import { ADMIN_TOKEN } from '../../fixtures/shared/data.js';
import { app as vulnerableApp } from '../../fixtures/vulnerable-api/server.js';
import { app as hardenedApp } from '../../fixtures/hardened-api/server.js';

const CTX = { userId: null, sessionId: 'sec', runId: 'run-sec' };
let vulnUrl;
let hardUrl;
let servers = [];

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

/** Grants everything this scan needs and returns a bound tool runner. */
function runnerFor(url) {
  const host = new URL(url).host;
  for (const riskClass of [RISK_CLASS.NETWORK_READ, RISK_CLASS.NETWORK_PROBE]) {
    grantStore.grant({ userId: CTX.userId, sessionId: CTX.sessionId, riskClass, host });
  }
  return (name, input, ctx) => getTool(name).handler(input, { ...CTX, ...ctx });
}

beforeAll(async () => {
  await connectTestDb();
  await registerAllTools();
  const v = await listen(vulnerableApp);
  const h = await listen(hardenedApp);
  servers = [v.s, h.s];
  vulnUrl = v.url;
  hardUrl = h.url;
  env.ALLOW_PRIVATE_TARGETS = true; // fixtures are loopback
}, 60_000);

afterAll(async () => {
  env.ALLOW_PRIVATE_TARGETS = false;
  for (const s of servers) s.close();
  await disconnectTestDb();
});

beforeEach(async () => {
  await AuditEvent.collection.deleteMany({});
  grantStore.clear();
});

// ── The target set ───────────────────────────────────────────────────────────

/**
 * Different defects live at different endpoints, so a single-URL scan cannot
 * reach all six families: /admin/users has no injectable parameter and
 * reflects nothing. A real scan covers the surface, and so does this one.
 *
 * `intendedPublic` reflects each route's ACTUAL intent, identically for both
 * fixtures. /users/1 and /search are public by design in both; /admin/users is
 * privileged in both. Declaring anything else would be asserting a falsehood
 * about the target and would make the comparison meaningless.
 */
const TARGETS = [
  { path: '/users/1', intendedPublic: true, why: 'SQLi via path segment' },
  { path: '/items?ownerId=1', intendedPublic: true, why: 'SQLi via query parameter' },
  { path: '/search?q=agentiq', intendedPublic: true, why: 'reflected XSS' },
  { path: '/admin/users', intendedPublic: false, why: 'privileged route' },
];

/** Scans every target and merges the per-family results. */
async function scanAll(baseUrl) {
  const runTool = runnerFor(baseUrl);
  const merged = new Map();

  for (const target of TARGETS) {
    const scan = await runSecurityAgent({
      url: `${baseUrl}${target.path}`,
      method: 'GET',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      intendedPublic: target.intendedPublic,
      runTool,
      context: CTX,
    });
    for (const family of scan.families) {
      const prev = merged.get(family.family) ?? { family: family.family, findings: [], notes: [] };
      prev.findings.push(...family.findings);
      if (family.note) prev.notes.push(`${target.path}: ${family.note}`);
      if (family.error) prev.notes.push(`${target.path} ERROR: ${family.error}`);
      merged.set(family.family, prev);
    }
  }

  const families = [...merged.values()];
  return { families, findings: families.flatMap((f) => f.findings) };
}

// ── RECALL ───────────────────────────────────────────────────────────────────

describe('RECALL: vulnerable-api', () => {
  let scan;

  beforeAll(async () => {
    grantStore.clear();
    scan = await scanAll(vulnUrl);
  }, 120_000);

  it('detects at least 5 of the 6 families', () => {
    const detected = scan.families.filter((f) => f.findings.length > 0).map((f) => f.family);
    expect(detected.length, `detected: ${detected.join(', ')}`).toBeGreaterThanOrEqual(5);
  });

  it('detects SQL injection and names the database engine', () => {
    const sqli = scan.families.find((f) => f.family === 'sqli');
    expect(sqli.findings.length).toBeGreaterThan(0);
    expect(sqli.findings.some((f) => /SQLite/i.test(f.signal))).toBe(true);
  });

  it('detects reflected XSS', () => {
    expect(scan.families.find((f) => f.family === 'xss').findings.length).toBeGreaterThan(0);
  });

  it('detects broken authentication on the privileged route', () => {
    const auth = scan.families.find((f) => f.family === 'auth');
    expect(auth.findings.length).toBeGreaterThan(0);
    // HIGH, not CRITICAL: this route runs NO credential check at all, which the
    // forged-credential request proves. CRITICAL is reserved for the subtler
    // case where credentials ARE validated but their absence is permitted.
    expect(auth.findings[0].severity).toBe('high');
    expect(auth.findings[0].signal).toMatch(/INVALID credential/i);
  });

  it('detects the CORS misconfiguration', () => {
    const cors = scan.families.find((f) => f.family === 'cors');
    expect(cors.findings.length).toBeGreaterThan(0);
    expect(cors.findings[0].signal).toMatch(/Allow-Origin: \*/);
  });

  it('detects missing security headers', () => {
    expect(scan.families.find((f) => f.family === 'headers').findings.length).toBeGreaterThan(0);
  });

  it('detects absent rate limiting', () => {
    expect(scan.families.find((f) => f.family === 'rate').findings.length).toBeGreaterThan(0);
  });

  it('EVERY finding carries payload, signal AND baseline', () => {
    // docs/03_App_Flow.md B2: "A finding with no payload and no baseline is not
    // a finding. Show the evidence or do not make the claim."
    for (const f of scan.findings) {
      expect(f.payload, `${f.family} payload`).toBeTruthy();
      expect(f.signal, `${f.family} signal`).toBeTruthy();
      expect(f.baseline, `${f.family} baseline`).toBeTruthy();
      expect(f.explanation, `${f.family} explanation`).toBeTruthy();
      expect(f.remediation, `${f.family} remediation`).toBeTruthy();
      expect(['critical', 'high', 'medium', 'low']).toContain(f.severity);
      expect(f.owasp).toMatch(/^API\d:2023/);
    }
  });
});

// ── PRECISION: the number that matters most ──────────────────────────────────

describe('PRECISION: hardened-api must produce ZERO findings', () => {
  let scan;

  beforeAll(async () => {
    grantStore.clear();
    // The SAME targets, the SAME declarations. Anything reported here is by
    // construction a false positive, because the contract is identical.
    scan = await scanAll(hardUrl);
  }, 120_000);

  it('reports no findings at all', () => {
    const detail = scan.findings
      .map((f) => `${f.family}/${f.severity}: ${f.signal}`)
      .join('\n  ');
    expect(scan.findings, `unexpected findings:\n  ${detail}`).toHaveLength(0);
  });

  it('still RUNS all six families: clean is a result, not a skip', () => {
    expect(scan.families).toHaveLength(6);
    expect(scan.families.every((f) => f.findings.length === 0)).toBe(true);
  });

  it('attaches the honest disclaimer to a clean result', async () => {
    // docs/03_App_Flow.md B2: a clean scan is not a guarantee, and says so.
    const one = await runSecurityAgent({
      url: `${hardUrl}/users/1`, intendedPublic: true,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      runTool: runnerFor(hardUrl), context: CTX,
    });
    expect(one.summary.disclaimer).toMatch(/not a guarantee of security/i);
  }, 60_000);
});

// ── intendedPublic: the auth false positive ──────────────────────────────────

describe('intendedPublic prevents the auth false positive on public APIs', () => {
  it('reports NOTHING on a public endpoint declared public', async () => {
    // The naive rule flags every anonymous 200 as "Accessible without
    // authentication", which fires on every public API.
    const scan = await runSecurityAgent({
      url: `${vulnUrl}/users/1`, families: ['auth'], intendedPublic: true,
      runTool: runnerFor(vulnUrl), context: CTX,
    });
    expect(scan.findings).toHaveLength(0);
    expect(scan.families[0].note).toMatch(/intentionally public/i);
  });

  it('reports nothing when no credentials were supplied to strip', async () => {
    // A 200 with no credentials sent proves only that the endpoint answered.
    const scan = await runSecurityAgent({
      url: `${vulnUrl}/users/1`, families: ['auth'], intendedPublic: false,
      headers: {}, runTool: runnerFor(vulnUrl), context: CTX,
    });
    expect(scan.findings).toHaveLength(0);
    expect(scan.families[0].note).toMatch(/none could be stripped/i);
  });

  it('DOES report when credentials are stripped and access is unchanged', async () => {
    const scan = await runSecurityAgent({
      url: `${vulnUrl}/admin/users`, families: ['auth'], intendedPublic: false,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      runTool: runnerFor(vulnUrl), context: CTX,
    });
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0].payload).toMatch(/authorization/i);
  });

  it('does NOT report on the hardened equivalent', async () => {
    const scan = await runSecurityAgent({
      url: `${hardUrl}/admin/users`, families: ['auth'], intendedPublic: false,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      runTool: runnerFor(hardUrl), context: CTX,
    });
    expect(scan.findings).toHaveLength(0);
  });
});

// ── Fingerprints ─────────────────────────────────────────────────────────────

describe('fingerprints work on JSON bodies, not just strings', () => {
  it('finds a driver error nested inside a JSON object', () => {
    // A `typeof res.data === "string"` check misses every JSON API.
    const body = { error: { detail: 'SQLSTATE[42000]: Syntax error near "OR"' } };
    const hit = findDbError(body);
    expect(hit.found).toBe(true);
    expect(hit.engine).toBe('SQLSTATE');
  });

  it.each([
    ['You have an error in your SQL syntax; check the manual', 'MySQL'],
    ['PG::SyntaxError: unterminated quoted string', 'PostgreSQL'],
    ['SQLITE_ERROR: unrecognized token', 'SQLite'],
    ['Unclosed quotation mark after the character string', 'MSSQL'],
    ['ORA-01756: quoted string not properly terminated', 'Oracle'],
    ['[Microsoft][ODBC SQL Server Driver]', 'ODBC'],
  ])('fingerprints %s as %s', (text, engine) => {
    expect(findDbError(text).engine).toBe(engine);
  });

  it('does NOT fire on ordinary prose containing the word sql', () => {
    // A naive `.includes("sql")` would flag this.
    expect(findDbError('No SQL knowledge is required to use this API.').found).toBe(false);
    expect(findDbError({ message: 'Learn SQL basics here' }).found).toBe(false);
  });

  it('bodyToText flattens objects so nothing hides in a nested field', () => {
    expect(bodyToText({ a: { b: 'ORA-00933' } })).toContain('ORA-00933');
  });
});

describe('payloads are non-destructive: a hard ethical boundary', () => {
  it('no SQLi payload contains a destructive keyword', () => {
    for (const p of SQLI_PAYLOADS) {
      expect(DESTRUCTIVE.test(p.value), `${p.value} must be read-only`).toBe(false);
    }
  });
});

// ── Baseline differential ────────────────────────────────────────────────────

describe('baseline differential: kills "any 500 = SQLi"', () => {
  it('an endpoint already 500ing on benign input yields NO claim', async () => {
    const b = captureBaseline({ status: 500, body: 'boom', headers: {}, durationMs: 10 });
    expect(baselineIsBroken(b)).toBe(true);
  });

  it('a status change alone is material; a length change alone is not', () => {
    const baseline = captureBaseline({ status: 200, body: 'x'.repeat(1000), headers: { 'content-type': 'application/json' }, durationMs: 50 });
    const longer = compare(baseline, { status: 200, body: 'x'.repeat(1400), headers: { 'content-type': 'application/json' }, durationMs: 55 });
    // Reflection naturally lengthens a body: that must not be a finding.
    expect(longer.material).toBe(false);

    const errored = compare(baseline, { status: 500, body: 'err', headers: { 'content-type': 'application/json' }, durationMs: 60 });
    expect(errored.material).toBe(true);
    expect(errored.becameError).toBe(true);
  });

  it('reports the comparison in words a human can check', () => {
    const baseline = captureBaseline({ status: 200, body: 'abc', headers: {}, durationMs: 20 });
    const diff = compare(baseline, { status: 500, body: 'x', headers: {}, durationMs: 30 });
    expect(diff.summary).toMatch(/baseline 200.*→.*probe 500/);
  });
});

describe('stripCredentials', () => {
  it('removes every credential-bearing header and reports which', () => {
    const { headers, removed } = stripCredentials({
      authorization: 'Bearer x', cookie: 'a=b', 'X-API-Key': 'k', accept: 'application/json',
    });
    expect(headers).toEqual({ accept: 'application/json' });
    expect(removed.sort()).toEqual(['X-API-Key', 'authorization', 'cookie']);
  });
});

// ── Safety and auditability ──────────────────────────────────────────────────

describe('safety', () => {
  it('every probe request is audited', async () => {
    await runSecurityAgent({
      url: `${vulnUrl}/users/1`, families: ['headers'],
      runTool: runnerFor(vulnUrl), context: CTX,
    });
    const rows = await AuditEvent.find({ tool: 'probe_headers' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].runId).toBe('run-sec');
  });

  it('an ungranted probe family is refused and audited as denied', async () => {
    grantStore.clear();
    const runTool = (name, input, ctx) => getTool(name).handler(input, { ...CTX, ...ctx });
    const scan = await runSecurityAgent({
      url: `${vulnUrl}/users/1`, families: ['sqli'], runTool, context: CTX,
    });
    expect(scan.families[0].error).toMatch(/approve/i);
    const rows = await AuditEvent.find({ tool: 'probe_sqli' }).lean();
    expect(rows[0].outcome).toBe('denied');
  });

  it('one family failing does not abandon the scan', async () => {
    const runTool = async (name, input, ctx) => {
      if (name === 'probe_sqli') throw new Error('simulated failure');
      return getTool(name).handler(input, { ...CTX, ...ctx });
    };
    grantStore.grant({
      userId: CTX.userId, sessionId: CTX.sessionId,
      riskClass: RISK_CLASS.NETWORK_READ, host: new URL(vulnUrl).host,
    });
    const scan = await runSecurityAgent({
      url: `${vulnUrl}/users/1`, families: ['sqli', 'headers'], runTool, context: CTX,
    });
    expect(scan.families.find((f) => f.family === 'sqli').error).toBe('simulated failure');
    expect(scan.families.find((f) => f.family === 'headers').findings.length).toBeGreaterThan(0);
  });
});

describe('summary', () => {
  it('counts findings by severity', () => {
    expect(countBySeverity([
      { severity: 'critical' }, { severity: 'high' }, { severity: 'high' }, { severity: 'low' },
    ])).toEqual({ critical: 1, high: 2, medium: 0, low: 1 });
  });

  it('declares all six families', () => {
    expect(FAMILIES.map((f) => f.key)).toEqual(['sqli', 'xss', 'auth', 'cors', 'headers', 'rate']);
  });
});
