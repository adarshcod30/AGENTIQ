/**
 * MEASUREMENT 1: security detection: precision and recall per family.
 *
 * docs/01_PRD.md F10 §1.
 *
 * Every endpoint is scanned on BOTH apps with the SAME families and the SAME
 * declared intent. The apps share their routes, seed data and response shapes
 * (fixtures/shared/data.js), and a contract test asserts they stay identical,
 * so a finding on one and not the other can only be explained by the defect,
 * which is the property that makes these numbers interpretable at all.
 *
 * Counting, stated precisely:
 *
 *   TP  a family fires on vulnerable-api where the ground truth says it should
 *   FN  it does not fire there
 *   FP  it fires anywhere it should not: on hardened-api (ALWAYS wrong, by
 *       construction) or on a vulnerable-api family that is not defective
 *   TN  it correctly stays silent
 *
 * The hardened app is where the honest number comes from. Recall alone is easy:
 * a scanner that reported everything on everything would score 100%.
 */
import { runSecurityAgent } from '../server/src/agents/security.agent.js';
import { TARGETS, FAMILIES } from './targets.js';
import { grantFor, runTool, CONTEXT, ratio } from './lib.js';

export async function measureSecurity({ vulnerableUrl, hardenedUrl, log = () => {} }) {
  grantFor(vulnerableUrl);
  grantFor(hardenedUrl);

  const observations = [];

  for (const [variant, base] of [['vulnerable', vulnerableUrl], ['hardened', hardenedUrl]]) {
    for (const target of TARGETS) {
      const url = `${base}${target.path}`;
      log(`  scanning ${variant.padEnd(10)} ${target.path}`);

      const scan = await runSecurityAgent({
        url,
        method: target.method,
        // The auth family cannot draw any conclusion without a credential to
        // strip and tamper with: see the note in targets.js.
        headers: target.headers ?? {},
        intendedPublic: target.intendedPublic,
        families: FAMILIES,
        runTool,
        context: CONTEXT,
      });

      for (const family of FAMILIES) {
        const result = scan.families.find((f) => f.family === family);
        const fired = (result?.findings.length ?? 0) > 0;
        const expected = variant === 'vulnerable' && target.vulnerable.includes(family);

        observations.push({
          variant,
          target: target.id,
          path: target.path,
          intendedPublic: target.intendedPublic,
          family,
          expected,
          fired,
          outcome: expected
            ? (fired ? 'TP' : 'FN')
            : (fired ? 'FP' : 'TN'),
          errored: Boolean(result?.error),
          severities: (result?.findings ?? []).map((f) => f.severity),
        });
      }
    }
  }

  return { observations, ...summarise(observations) };
}

function tally(rows) {
  const t = { TP: 0, FP: 0, FN: 0, TN: 0 };
  for (const r of rows) t[r.outcome] += 1;
  return {
    ...t,
    precision: ratio(t.TP, t.TP + t.FP),
    recall: ratio(t.TP, t.TP + t.FN),
    f1: ratio(2 * t.TP, 2 * t.TP + t.FP + t.FN),
  };
}

export function summarise(observations) {
  const perFamily = Object.fromEntries(
    FAMILIES.map((f) => [f, tally(observations.filter((o) => o.family === f))]),
  );

  const hardened = observations.filter((o) => o.variant === 'hardened');
  const falsePositives = observations.filter((o) => o.outcome === 'FP');

  return {
    overall: tally(observations),
    perFamily,
    /**
     * The headline honesty number: findings reported against an app that is,
     * by construction, not vulnerable. docs/01_PRD.md F3 requires this to be
     * zero, and requires the measured rate in the report either way.
     */
    hardenedFalsePositiveRate: ratio(
      hardened.filter((o) => o.fired).length, hardened.length,
    ),
    falsePositives: falsePositives.map((o) => `${o.variant}:${o.path} → ${o.family}`),
  };
}
