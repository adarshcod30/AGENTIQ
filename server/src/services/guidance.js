/**
 * The guidance engine: turn findings into advice.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §C. A report that only says "4 tests failed" or
 * "missing security headers" leaves the work to the reader. This turns every
 * signal the pipeline produced into a recommendation with four parts: WHAT is
 * wrong, WHY it is wrong (the root cause, not the symptom), HOW to fix it, and
 * TIPS to do it well. It is rule-based and deterministic, in the same spirit as
 * the SAST scanner and the deploy diagnosis: the reasoning is transparent and
 * reproducible, not an LLM improvising prose.
 *
 * Recommendations are grouped by stage and ordered by priority, so a reader gets
 * a single prioritised action plan for making the project ready.
 */

const P = { CRITICAL: 1, HIGH: 2, MEDIUM: 3, LOW: 4 };
const SEV_TO_P = { critical: 1, high: 2, medium: 3, low: 4, info: 4 };
export const PRIORITY_LABEL = { 1: 'critical', 2: 'high', 3: 'medium', 4: 'low' };

/**
 * Root cause and tips per security finding category. The concrete fix comes from
 * the finding's own remediation (already specific to the match); `fix` here is
 * the fallback when a finding carries none.
 */
const SECURITY_GUIDANCE = {
  'sql-injection': {
    why: 'Input is concatenated into a SQL string, so a crafted value can change the query and read or destroy data.',
    fix: 'Use parameterised queries or an ORM binding; never build SQL by string concatenation.',
    tips: ['Parameterise every query, even "internal" ones', 'Grant the database user the least privilege it needs', 'Add a test that sends a quote in the input and asserts it is treated as data'],
  },
  'command-injection': {
    why: 'A shell command is built from a variable, so an attacker-controlled value can run arbitrary commands on the host.',
    fix: 'Pass arguments as an array to spawn; never build a shell string from input.',
    tips: ['Prefer a library over shelling out', 'If you must, allow-list the exact commands and arguments', 'Never pass user input to a shell'],
  },
  'code-eval': {
    why: 'Dynamic evaluation (eval / new Function) turns any controlled input into executable code.',
    fix: 'Remove the dynamic evaluation and use a safe parser or an explicit branch instead.',
    tips: ['Parse JSON with JSON.parse, not eval', 'Replace dynamic dispatch with a lookup table', 'If templating, use a sandboxed engine'],
  },
  'path-traversal': {
    why: 'A filesystem path is taken from the request, so "../" sequences can read files outside the intended directory.',
    fix: 'Resolve the path and confine it to an allowed base directory before reading.',
    tips: ['Use path.resolve and check it starts with the base dir', 'Reject any path containing ".."', 'Serve files by id from a map, not by raw path'],
  },
  'weak-hash': {
    why: 'MD5 and SHA-1 are broken for security use: collisions are cheap, so they cannot protect integrity or passwords.',
    fix: 'Use SHA-256 or better for integrity; for passwords use bcrypt, scrypt or argon2.',
    tips: ['Never hash passwords with a plain hash, use a KDF', 'Add a per-user salt', 'Migrate existing hashes on next login'],
  },
  'open-redirect': {
    why: 'The redirect target comes from the request, so a link to your site can bounce a victim to an attacker page.',
    fix: 'Redirect only to an allow-listed set of paths, never to a raw request value.',
    tips: ['Allow-list destinations', 'Redirect to a path, not a full URL', 'Show an interstitial for external links'],
  },
  'insecure-random': {
    why: 'Math.random is predictable, so a token or id built from it can be guessed.',
    fix: 'Use crypto.randomUUID or crypto.randomBytes for anything that must be unguessable.',
    tips: ['Reserve Math.random for non-security use', 'Make tokens long and high-entropy', 'Rotate any token that was generated weakly'],
  },
  'missing-security-headers': {
    why: 'Without helmet (or equivalent) responses lack CSP, HSTS, X-Content-Type-Options and X-Frame-Options, which browsers use to contain attacks.',
    fix: 'Add app.use(helmet()) near the top of the middleware chain.',
    tips: ['Start with helmet defaults, then tighten CSP', 'Set HSTS only once you are HTTPS-only', 'Test headers with an online scanner after deploy'],
  },
  'cors-permissive': {
    why: 'Reflecting the request origin while allowing credentials lets any website make authenticated cross-origin requests as your users.',
    fix: 'Set an explicit allow-list of origins; never combine a reflected origin with credentials.',
    tips: ['List the exact origins you trust', 'Do not use origin:true with credentials:true', 'Keep the list in configuration, not code'],
  },
  'cors-wildcard': {
    why: 'A wildcard CORS origin exposes the API to every website.',
    fix: 'Restrict the origin to the domains that actually need access.',
    tips: ['Replace * with an explicit list', 'Separate public and authenticated endpoints', 'Review CORS whenever you add a client'],
  },
  'committed-env': {
    why: 'A committed .env usually carries real secrets, and if it is tracked by git those secrets live in history forever.',
    fix: 'Remove it from version control, add .env to .gitignore, and rotate anything it held.',
    tips: ['Rotate every secret that was committed', 'Use .env.example with placeholders', 'Scan history with a secret scanner'],
  },
  'docker-root': {
    why: 'A container running as root widens the blast radius of any code-execution bug to the whole container.',
    fix: 'Add a non-root USER before the CMD in the Dockerfile.',
    tips: ['Create a dedicated app user', 'Make the app directory owned by that user', 'Drop Linux capabilities you do not need'],
  },
  'vulnerable-dependency': {
    why: 'A dependency has a known published vulnerability, so your app inherits it whether or not you use the affected path.',
    fix: 'Run npm audit fix, or upgrade the package to a patched version.',
    tips: ['Pin and update dependencies regularly', 'Watch advisories for your stack', 'Remove packages you no longer use'],
  },
};

const SECRET_CATEGORIES = new Set([
  'aws-access-key', 'private-key', 'google-api-key', 'google-oauth-secret',
  'slack-token', 'stripe-key', 'jwt', 'mongo-uri-with-password', 'assigned-secret',
]);

const rec = (o) => ({ tips: [], ...o });

/** WHY/HOW for a security finding, using its own remediation where it has one. */
function securityRec(category, findings) {
  const g = SECURITY_GUIDANCE[category] ?? (SECRET_CATEGORIES.has(category)
    ? {
      why: 'A credential appears hardcoded in the source. Anyone with the code has it, and it survives in git history even after removal.',
      fix: 'Move it to an environment variable or a secret manager, and rotate the exposed value.',
      tips: ['Rotate the exposed secret now', 'Load secrets from the environment', 'Add a pre-commit secret scanner'],
    }
    : null);

  const top = findings[0];
  const priority = SEV_TO_P[top.severity] ?? P.MEDIUM;
  const where = findings
    .map((f) => f.location?.file && `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}`)
    .filter(Boolean).slice(0, 3);

  return rec({
    stage: 'Security',
    priority,
    title: findings.length > 1 ? `${top.title} (${findings.length} occurrences)` : top.title,
    why: g?.why ?? top.description ?? 'A security issue was detected.',
    fix: top.remediation || g?.fix || 'Review and remediate this finding.',
    tips: g?.tips ?? [],
    where,
  });
}

/**
 * Builds the prioritised recommendation list from an assessment and its model.
 * @returns {Array<{id,stage,priority,title,why,fix,tips,where?}>}
 */
export function buildRecommendations({ assessment, model } = {}) {
  const recs = [];
  const endpoints = assessment?.endpoints ?? [];
  const discovered = model?.endpoints ?? endpoints;

  // ── Discovery ───────────────────────────────────────────────────────────────
  if ((discovered?.length ?? 0) === 0) {
    recs.push(rec({
      stage: 'Discovery', priority: P.HIGH,
      title: 'No API routes were discovered',
      why: 'Discovery supports Express, FastAPI, Flask and Next.js. Routes defined another way (a different framework, or dynamic registration at runtime) are not detected statically.',
      fix: 'Confirm the framework is one of the supported set, or provide an OpenAPI spec to test against.',
      tips: ['Check the routes are declared, not registered dynamically', 'Import an OpenAPI/Swagger spec from the Specs page', 'For an unsupported framework, test by URL from the Test Runner'],
    }));
  }

  const appNotStarted = !assessment?.baseUrl && (discovered?.length ?? 0) > 0;
  if (appNotStarted) {
    recs.push(rec({
      stage: 'Discovery', priority: P.HIGH,
      title: 'The app could not be started, so its endpoints were not exercised',
      why: 'AGENTIQ starts your app on loopback to test it. It found no dev/start/serve script, or the app failed to bind the port before the readiness timeout.',
      fix: 'Add a start script that binds to process.env.PORT and listens on 127.0.0.1.',
      tips: ['Bind to process.env.PORT, never a hardcoded port', 'Give required env vars safe local defaults, the sandbox scrubs secrets', 'A DB-backed app may need its database reachable to start'],
    }));
  }

  // ── Testing: group failing endpoints by the category that failed ─────────────
  const byType = { positive: [], negative: [], boundary: [], other: [] };
  for (const e of endpoints) {
    if (e.status !== 'complete' || !((e.failed ?? 0) > 0)) continue;
    const label = `${e.method} ${e.path}`;
    const cats = new Set((e.failures ?? []).map((f) => f.category).filter(Boolean));
    if (cats.size === 0) byType.other.push(label);
    else for (const c of cats) (byType[c] ?? byType.other).push(label);
  }
  if (byType.positive.length) {
    recs.push(rec({
      stage: 'Testing', priority: P.CRITICAL,
      title: `The happy path is failing on ${byType.positive.length} endpoint(s)`,
      why: 'A valid, well-formed request did not return the expected successful response, so the core behaviour of these endpoints is broken.',
      fix: 'Fix the handler and make sure its dependencies (database, environment, downstream services) are available where it runs.',
      tips: ['Reproduce with the exact request from the failing case', 'Check server logs for the stack trace', 'Verify required env vars are set in the run environment'],
      where: byType.positive.slice(0, 5),
    }));
  }
  if (byType.negative.length) {
    recs.push(rec({
      stage: 'Testing', priority: P.HIGH,
      title: `${byType.negative.length} endpoint(s) accept invalid input`,
      why: 'Negative cases (missing fields, wrong types, malformed bodies) did not get a 4xx, so these endpoints process bad input instead of rejecting it. That is how bad data and injection get in.',
      fix: 'Validate the body, params and query, and return 400 with a clear error on bad input.',
      tips: ['Use a schema validator (zod, joi, express-validator, or pydantic for FastAPI)', 'Reject unknown fields rather than ignoring them', 'Never pass unvalidated input into a query or command'],
      where: byType.negative.slice(0, 5),
    }));
  }
  if (byType.boundary.length) {
    recs.push(rec({
      stage: 'Testing', priority: P.MEDIUM,
      title: `${byType.boundary.length} endpoint(s) mishandle edge cases`,
      why: 'Boundary inputs (empty, very long, zero, negative, unicode) produced unexpected results.',
      fix: 'Handle edge cases explicitly and set sane limits.',
      tips: ['Set maximum lengths and numeric bounds', 'Decide behaviour for empty and null explicitly', 'Add a test for each edge you now handle'],
      where: byType.boundary.slice(0, 5),
    }));
  }
  if (byType.other.length) {
    recs.push(rec({
      stage: 'Testing', priority: P.MEDIUM,
      title: `${byType.other.length} endpoint(s) have failing tests`,
      why: 'One or more generated cases failed for these endpoints.',
      fix: 'Open the endpoint and review the failing assertions to see what the response should have been.',
      tips: ['Compare the expected and actual values in each assertion', 'Fix the most common failure first'],
      where: byType.other.slice(0, 5),
    }));
  }

  // ── Security: one recommendation per finding category ────────────────────────
  const findings = assessment?.security?.findings ?? [];
  const byCategory = new Map();
  for (const f of findings) {
    const key = f.category ?? f.family ?? 'security';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(f);
  }
  for (const [category, group] of byCategory) {
    group.sort((a, b) => (SEV_TO_P[a.severity] ?? 4) - (SEV_TO_P[b.severity] ?? 4));
    recs.push(securityRec(category, group));
  }

  // ── Deployment ───────────────────────────────────────────────────────────────
  if (assessment?.readiness?.ready) {
    recs.push(rec({
      stage: 'Deployment', priority: P.LOW,
      title: 'Ready to deploy: a few things to set up first',
      why: 'The readiness checks passed. These are the operational basics a production service still needs.',
      fix: 'Configure environment, health checks and monitoring on your host before or during the first deploy.',
      tips: ['Set every required env var on the host', 'Expose a health endpoint and point the platform at it', 'Turn on logs and error alerts from day one'],
    }));
  }

  // Stable order and ids: priority first, then stage, then title.
  const STAGE_ORDER = { Discovery: 0, Testing: 1, Security: 2, Deployment: 3 };
  recs.sort((a, b) => a.priority - b.priority
    || (STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
    || a.title.localeCompare(b.title));
  return recs.map((r, i) => ({ id: `rec-${i + 1}`, ...r }));
}

/** A compact count by priority, for a headline badge. */
export function summariseRecommendations(recs = []) {
  const by = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of recs) by[PRIORITY_LABEL[r.priority]] += 1;
  return { total: recs.length, byPriority: by };
}

export default { buildRecommendations, summariseRecommendations };
