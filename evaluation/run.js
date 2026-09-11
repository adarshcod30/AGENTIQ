#!/usr/bin/env node
/**
 * `npm run evaluate`: the evaluation harness. docs/01_PRD.md F10.
 *
 * Produces docs/90_EVALUATION.md plus the raw observations in
 * evaluation/results/, so every figure in that document can be recomputed or
 * disputed.
 *
 * It exits NON-ZERO and says exactly what is missing rather than printing a
 * plausible-looking table. Reporting numbers that were never measured is the
 * single failure mode this project exists to avoid.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDotenv } from '../server/src/config/env.js';

loadDotenv();

const { env } = await import('../server/src/config/env.js');
const { providerOrder } = await import('../server/src/services/llm.js');
const {
  prepareTools, restoreTools, listen, connectEvalDb, disconnectEvalDb, auditRowCount,
} = await import('./lib.js');
const { measureSecurity } = await import('./security.eval.js');
const { measureMutation } = await import('./mutation.eval.js');
const { renderReport } = await import('./report.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => process.stdout.write(`${m}\n`);

function die(message) {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(1);
}

// ── preconditions, checked before anything is started ───────────────────────
if (providerOrder().length === 0) {
  die(
    'No LLM provider is configured, so test generation cannot run and §2/§3 would be\n' +
    '  unmeasurable. Set GROQ_API_KEY, or BEDROCK_MODEL_ID with AWS credentials.\n\n' +
    '  Refusing to emit a partial table that looks complete.',
  );
}

const started = Date.now();
log('\nAGENTIQ evaluation harness');
log(`  provider order: ${providerOrder().join(' -> ')}\n`);

await prepareTools();

// Every tool call writes an audit row; without a connection mongoose buffers
// each insert for ten seconds before failing, which is the difference between a
// two-minute run and a twenty-minute one.
try {
  await connectEvalDb();
  log('  connected to the agentiq_eval database (dropped and recreated)\n');
} catch (err) {
  die(
    `Could not reach MongoDB, and every tool call writes an audit row:\n  ${err.message}\n\n` +
    '  Set MONGO_URI in server/.env. The harness uses a dedicated `agentiq_eval`\n' +
    '  database and drops it at the start of every run, so nothing else is touched.',
  );
}

const { app: vulnerableApp } = await import('../fixtures/vulnerable-api/server.js');
const { app: hardenedApp } = await import('../fixtures/hardened-api/server.js');

const vulnerable = await listen(vulnerableApp);
const hardened = await listen(hardenedApp);

let security;
let mutation;
try {
  log('1/2  security detection: precision and recall per family');
  security = await measureSecurity({
    vulnerableUrl: vulnerable.url, hardenedUrl: hardened.url, log,
  });
  log(`     ${security.overall.TP} TP · ${security.overall.FP} FP · ${security.overall.FN} FN`);
  log(`     false positives on hardened: ${security.falsePositives.length}\n`);

  log('2/2  mutation score and grounding ablation');
  const specText = await readFile(path.join(ROOT, 'fixtures/hardened-api/openapi.json'), 'utf8');
  mutation = await measureMutation({ specText, log });
  log(`     grounded ${fmt(mutation.ablation.grounded)} · ` +
      `description-only ${fmt(mutation.ablation.ungrounded)}\n`);
} catch (err) {
  die(`Measurement failed, so no report was written:\n  ${err.message}`);
} finally {
  vulnerable.server.close();
  hardened.server.close();
  restoreTools();
}

const audit = await auditRowCount();
log(`     ${audit.total} audited tool invocations written\n`);
await disconnectEvalDb();

const durationSec = Math.round((Date.now() - started) / 10) / 100;
const firstSuite = mutation.suites[0] ?? {};

const meta = {
  generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  node: process.version,
  commit: gitCommit(),
  durationSec,
  provider: firstSuite.provider ?? providerOrder()[0],
  model: firstSuite.model ?? null,
  llmPrimary: env.LLM_PRIMARY,
  audit,
};

await mkdir(path.join(ROOT, 'evaluation/results'), { recursive: true });
await writeFile(
  path.join(ROOT, 'evaluation/results/latest.json'),
  `${JSON.stringify({ meta, security, mutation }, null, 2)}\n`,
);

const report = renderReport({ security, mutation, meta });
await mkdir(path.join(ROOT, 'docs'), { recursive: true });
await writeFile(path.join(ROOT, 'docs/90_EVALUATION.md'), `${report}\n`);

log(`Wrote docs/90_EVALUATION.md and evaluation/results/latest.json in ${durationSec}s`);

function fmt(v) { return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`; }

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {
    return 'unknown';
  }
}
