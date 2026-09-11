/**
 * MEASUREMENTS 2 & 3: test adequacy (mutation score) and the grounding ablation.
 *
 * docs/01_PRD.md F10 §2 and §3. They share a module because they share the
 * expensive half: generation. The ablation IS the same measurement run twice,
 * once with spec grounding and once without, against the identical mutant set.
 *
 * ── THE PROTOCOL ────────────────────────────────────────────────────────────
 *   1. Generate a suite ONCE per (endpoint, grounding mode).  [the only LLM cost]
 *   2. Execute it against the UNMUTATED hardened app.         -> baseline
 *   3. Execute the SAME suite against each mutant.            -> kill or survive
 *
 * A mutant is KILLED when an assertion that PASSED at baseline FAILS against
 * the mutant. Comparing to the baseline rather than counting raw failures is
 * what stops an already-broken test from being credited with a kill it did not
 * earn: a suite full of wrong assertions would otherwise score brilliantly.
 *
 * ── WHY THIS IS A FAIR ABLATION ─────────────────────────────────────────────
 * Same model, same temperature, same case count, same endpoints, same mutants,
 * same execution path. The ONLY difference is whether buildPrompt() receives
 * the parsed OpenAPI operation. docs/01_PRD.md F4 calls this "your strongest
 * evaluation story", and it only holds if nothing else moves.
 */
import { generateCases, executeCases } from '../server/src/agents/testing.agent.js';
import { MUTANTS, applyMutant, mutantsFor } from './mutants.js';
import { MUTATION_TARGETS } from './targets.js';
import { listen, grantFor, runTool, CONTEXT, ratio } from './lib.js';


/**
 * Re-points a generated suite at a different server.
 *
 * generateCases() resolves each case to an ABSOLUTE url at generation time, so
 * the only way to run the identical suite elsewhere is to swap the origin.
 * Path, query and every assertion are untouched, which is the point: the suite
 * must be bit-identical across baseline and mutants, or the comparison means
 * nothing.
 */
function repoint(cases, toBase) {
  const to = new URL(toBase);
  return cases.map((c) => {
    const u = new URL(c.url);
    u.protocol = to.protocol;
    u.host = to.host;
    return { ...c, url: u.toString() };
  });
}

/** Stable identity for one assertion, so baseline and mutant runs line up. */
const assertionKey = (caseIndex, assertionIndex) => `${caseIndex}:${assertionIndex}`;

/** Bounded retries before a suite is recorded as a generation failure. */
export const GENERATION_ATTEMPTS = 3;

/** Which assertions passed, keyed stably. */
function passedSet(results) {
  const passed = new Set();
  results.forEach((r, i) => {
    (r.assertions ?? []).forEach((a, j) => {
      if (a.pass) passed.add(assertionKey(i, j));
    });
  });
  return passed;
}

/**
 * Loads a FRESH instance of the hardened app.
 *
 * ESM caches modules by full specifier, so the query string forces a new module
 * instance, which matters because each instance carries its own
 * express-rate-limit counter. Sharing one app across nine servers would let the
 * harness throttle itself and record 429s as mutant kills, which would be a
 * completely fabricated result.
 */
async function freshHardenedApp(tag) {
  const mod = await import(`../fixtures/hardened-api/server.js?eval=${tag}`);
  return mod.app;
}

export async function measureMutation({ specText, repeats = 3, log = () => {} }) {
  // Grounding comes from the parse_openapi TOOL: local.compute, audited like
  // everything else. No database is involved.
  const spec = await runTool('parse_openapi', { spec: specText });

  const servers = [];
  const suites = [];

  /**
   * Fresh servers PER REPEAT.
   *
   * The hardened fixture rate-limits itself at 60 requests/minute, and three
   * repeats push ~120 requests through each app instance. Reusing instances
   * across repeats tripped that limiter, and the harness correctly aborted
   * rather than record its own 429s as mutant kills. A new module instance per
   * repeat carries a new limiter, which is the honest fix: raising the
   * fixture's limit would have been tuning the system under test.
   */
  async function standUp(repeat) {
    const baseline = await listen(await freshHardenedApp(`baseline-r${repeat}`));
    servers.push(baseline.server);
    grantFor(baseline.url);

    const mutantEnvs = [];
    for (const mutant of MUTANTS) {
      const app = await freshHardenedApp(`${mutant.id}-r${repeat}`);
      const { server, url } = await listen(applyMutant(app, mutant));
      servers.push(server);
      grantFor(url);
      mutantEnvs.push({ mutant, url });
    }
    return { baseline, mutantEnvs };
  }
  const generation = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0, ms: 0 };

  try {
    /**
     * REPEATS. Generation is stochastic, so a single sample per arm can put a
     * counterintuitive headline in the report that is really just noise. Each arm
     * is run `repeats` times and the report gives the mean with the observed
     * range, so the ablation is a claim about a distribution rather than about
     * one lucky or unlucky draw.
     */
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const { baseline, mutantEnvs } = await standUp(repeat);
    for (const mode of ['grounded', 'ungrounded']) {
      for (const target of MUTATION_TARGETS) {
        const operation = mode === 'grounded' ? findOperation(spec, target) : null;
        if (mode === 'grounded' && !operation) {
          throw new Error(`No spec operation matches ${target.method} ${target.path}`);
        }

        log(`  [${repeat}/${repeats}] generating ${mode.padEnd(10)} ${target.path}`);
        const started = Date.now();

        /**
         * Generation is stochastic and occasionally returns a batch with no
         * usable case at all. Retry a bounded number of times, and if it still
         * fails, RECORD THE FAILURE AND CARRY ON rather than aborting.
         *
         * Aborting made a 24-call run hostage to its unluckiest draw. Recording
         * it is also more informative: how often generation fails outright is a
         * property of the generator worth measuring, so it becomes a reported
         * number instead of a crash.
         */
        let generated = null;
        let lastReason = null;
        for (let tryNo = 1; tryNo <= GENERATION_ATTEMPTS; tryNo += 1) {
          try {
            const candidate = await generateCases({
              url: `${baseline.url}${target.path}`,
              method: target.method,
              description: target.description,
              count: 5,
              operation,
            });
            if (candidate.cases.length > 0) { generated = candidate; break; }
            lastReason = `no usable cases (${candidate.discarded} discarded: ` +
              `${candidate.discardReasons.slice(0, 2).join('; ')})`;
          } catch (err) {
            lastReason = err.message;
          }
          log(`      attempt ${tryNo} failed: ${String(lastReason).slice(0, 90)}`);
        }

        if (!generated) {
          suites.push({
            repeat, mode, target: target.id, path: target.path,
            failed: true, reason: lastReason,
            generated: 0, discarded: 0, discardReasons: [], assertions: 0,
            baselinePassing: 0, baselineTotal: 0,
            generationMs: Date.now() - started, provider: null, model: null,
            kills: [],
          });
          generation.calls += GENERATION_ATTEMPTS;
          continue;
        }

        const genMs = Date.now() - started;

        generation.calls += 1;
        generation.ms += genMs;
        generation.inputTokens += generated.tokens?.input ?? 0;
        generation.outputTokens += generated.tokens?.output ?? 0;
        generation.costUsd += generated.costUsd ?? 0;

        // ── baseline ────────────────────────────────────────────────────────
        const baseResults = await executeCases({
          cases: generated.cases, runTool, context: CONTEXT,
        });
        assertNoThrottling(baseResults, 'baseline');
        const basePassed = passedSet(baseResults);

        // ── each APPLICABLE mutant ──────────────────────────────────────────
        // A suite for /users/1 sends no request to /items, so an /items mutant
        // is unkillable by it and must not enter the denominator.
        const applicable = new Set(mutantsFor(target.id).map((m) => m.id));
        const kills = [];
        for (const { mutant, url } of mutantEnvs.filter((e) => applicable.has(e.mutant.id))) {
          const results = await executeCases({
            cases: repoint(generated.cases, url), runTool, context: CONTEXT,
          });
          assertNoThrottling(results, mutant.id);

          const killed = detectKill(basePassed, results);
          kills.push({ mutant: mutant.id, category: mutant.category, killed });
        }

        suites.push({
          repeat,
          mode,
          target: target.id,
          path: target.path,
          generated: generated.cases.length,
          discarded: generated.discarded,
          discardReasons: generated.discardReasons.slice(0, 5),
          assertions: generated.cases.reduce((n, c) => n + c.assertions.length, 0),
          baselinePassing: basePassed.size,
          baselineTotal: baseResults.reduce((n, r) => n + (r.assertions?.length ?? 0), 0),
          generationMs: genMs,
          provider: generated.provider,
          model: generated.model,
          kills,
        });
      }
    }
    }
  } finally {
    for (const s of servers) s.close();
  }

  return { suites, generation, ...summariseMutation(suites) };
}

/**
 * A kill requires an assertion that passed at baseline to fail now.
 *
 * An assertion that was ALREADY failing tells us nothing about the mutant, and
 * an error (a transport failure, say) is not evidence either, so only a clean
 * pass→fail transition counts.
 */
function detectKill(basePassed, mutantResults) {
  for (const [i, r] of mutantResults.entries()) {
    for (const [j, a] of (r.assertions ?? []).entries()) {
      if (basePassed.has(assertionKey(i, j)) && a.pass === false) return true;
    }
  }
  return false;
}

/**
 * The harness must never mistake its own throttling for a finding.
 *
 * Each mutant has its own app instance and therefore its own rate-limit
 * counter, but if that ever stops being true a 429 would look exactly like a
 * killed mutant. Fail loudly rather than publish a fabricated score.
 */
function assertNoThrottling(results, label) {
  const throttled = results.filter((r) => r.httpStatus === 429);
  if (throttled.length) {
    throw new Error(
      `Rate limiting hit while executing "${label}" (${throttled.length} responses were 429). ` +
      'The harness would otherwise record its own throttling as a mutant kill. Aborting.',
    );
  }
}

function findOperation(spec, target) {
  // '/items?ownerId=1' -> '/items';  '/users/1' -> '/users/{id}'
  const pathOnly = target.path.split('?')[0];
  return spec.operations.find((o) => {
    if (o.method.toUpperCase() !== target.method.toUpperCase()) return false;
    if (o.path === pathOnly) return true;
    const re = new RegExp(`^${o.path.replace(/\{[^}]+\}/g, '[^/]+')}$`);
    return re.test(pathOnly);
  }) ?? null;
}

export function summariseMutation(suites) {
  const byMode = {};
  const repeats = [...new Set(suites.map((s) => s.repeat ?? 1))].sort();

  for (const mode of ['grounded', 'ungrounded']) {
    const rows = suites.filter((s) => s.mode === mode);

    // One score per repeat, so the report can quote a range rather than
    // implying a single number is the whole story.
    const perRepeat = repeats.map((r) => {
      const k = rows.filter((s) => (s.repeat ?? 1) === r).flatMap((s) => s.kills);
      return { repeat: r, killed: k.filter((x) => x.killed).length, total: k.length,
        score: ratio(k.filter((x) => x.killed).length, k.length) };
    });
    const all = rows.flatMap((s) => s.kills);
    const killed = all.filter((k) => k.killed).length;

    const byCategory = {};
    for (const k of all) {
      byCategory[k.category] ??= { killed: 0, total: 0 };
      byCategory[k.category].total += 1;
      if (k.killed) byCategory[k.category].killed += 1;
    }
    for (const c of Object.values(byCategory)) c.score = ratio(c.killed, c.total);

    const byMutant = {};
    for (const k of all) {
      byMutant[k.mutant] ??= { killed: 0, total: 0 };
      byMutant[k.mutant].total += 1;
      if (k.killed) byMutant[k.mutant].killed += 1;
    }

    const attempted = rows.length;
    const failedGenerations = rows.filter((r) => r.failed).length;

    byMode[mode] = {
      repeats: repeats.length,
      suitesAttempted: attempted,
      generationFailures: failedGenerations,
      generationSuccessRate: ratio(attempted - failedGenerations, attempted),
      perRepeat,
      scoreMin: perRepeat.reduce((m, r) => (r.score !== null && (m === null || r.score < m) ? r.score : m), null),
      scoreMax: perRepeat.reduce((m, r) => (r.score !== null && (m === null || r.score > m) ? r.score : m), null),
      suites: rows.length,
      casesGenerated: rows.reduce((n, s) => n + s.generated, 0),
      casesDiscarded: rows.reduce((n, s) => n + s.discarded, 0),
      assertions: rows.reduce((n, s) => n + s.assertions, 0),
      baselinePassRate: ratio(
        rows.reduce((n, s) => n + s.baselinePassing, 0),
        rows.reduce((n, s) => n + s.baselineTotal, 0),
      ),
      mutantsEvaluated: all.length,
      mutantsKilled: killed,
      mutationScore: ratio(killed, all.length),
      byCategory,
      byMutant,
    };
  }

  const g = byMode.grounded.mutationScore;
  const u = byMode.ungrounded.mutationScore;

  return {
    byMode,
    ablation: {
      grounded: g,
      ungrounded: u,
      // Reported as a signed delta in percentage points. If grounding does not
      // help, that is the result and it goes in the report unchanged.
      deltaPoints: g === null || u === null ? null : Number(((g - u) * 100).toFixed(1)),
    },
  };
}
