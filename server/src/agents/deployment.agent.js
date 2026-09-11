/**
 * DEPLOYMENT AGENT: docs/01_PRD.md F5.
 *
 * ⚠️ THIS FILE PERFORMS NO I/O. It may not import axios, fetch, node:http or any
 * HTTP client; tests/architecture.test.js fails the build if it does. Every
 * request it causes is made by an MCP tool (schema-validated, permission-checked,
 * SSRF-guarded and audited), exactly like the testing and security agents.
 *
 * ── WHY THIS IS MORE THAN A DEPLOY BUTTON ───────────────────────────────────
 * F5's acceptance criterion is a deployment that VERIFIES ITSELF. The flow is
 * three phases, and each phase sits in a different risk class, escalating:
 *
 *   1. PREFLIGHT  network.read   read-only checks against GitHub. Nothing is
 *                                changed. A `fail` here stops the flow before
 *                                any deploy.write action is ever attempted.
 *   2. DEPLOY     deploy.write   grant AND explicit confirmation. The only
 *                                phase that mutates anything.
 *   3. VERIFY     network.read   the testing and security agents, re-run
 *                  + probe       against the URL that just went live.
 *
 * A user can therefore consent to "check whether this would deploy" without
 * consenting to "deploy it", which is the distinction that makes the permission
 * model meaningful rather than decorative.
 *
 * Phase 3 lives in deployment.service.js because it has to persist a TestRun;
 * this file owns phases 1 and 2.
 */

/** GitHub's API host. The only host preflight contacts. */
export const GITHUB_API = 'https://api.github.com';

export const CHECK = { PASS: 'pass', WARN: 'warn', FAIL: 'fail' };

/** Deploy statuses Render can report. Mirrored from the tool so the agent
 *  can decide when to stop polling without importing the tool's transport. */
export const TERMINAL_SUCCESS = new Set(['live']);
export const TERMINAL_FAILURE = new Set([
  'build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated',
]);
export const isTerminalStatus = (s) => TERMINAL_SUCCESS.has(s) || TERMINAL_FAILURE.has(s);

/**
 * Values that look like a live credential being shipped into a deployment.
 *
 * Not a secret scanner: a nudge. The check reports the KEY, never the value,
 * because printing the secret back at the user in a preflight report would be
 * its own small disclosure.
 */
const SECRET_SHAPES = [
  /^rnd_[A-Za-z0-9_-]{10,}$/,          // Render
  /^sk-[A-Za-z0-9_-]{16,}$/,           // OpenAI-style
  /^gsk_[A-Za-z0-9_-]{16,}$/,          // Groq
  /^ghp_[A-Za-z0-9]{20,}$/,            // GitHub PAT
  /^AKIA[0-9A-Z]{16}$/,                // AWS access key id
  /^mongodb(\+srv)?:\/\/[^@]+:[^@]+@/, // Mongo URI with inline password
];

/** Parses a GitHub https URL into { owner, repo }, or null. */
export function parseGitHubRepo(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

const check = (name, status, detail) => ({ name, status, detail });

/**
 * PHASE 1: read-only checks, all against api.github.com.
 *
 * Returns every check it managed to run. A check that could not be evaluated is
 * a `warn`, never a silent pass: "we could not tell" and "it is fine" are
 * different answers, and the result says which one it is.
 */
export async function runPreflight({
  repo, branch = 'main', serviceName, runtime = 'node', envVars = {},
  runTool, context = {},
  // Overridable so the tests can drive a local fake GitHub rather than
  // depending on the real API, and on CI having network access to it.
  githubApi = GITHUB_API,
}) {
  const checks = [];

  // ── 1. repo format: pure local compute, no request ──────────────────────
  const parsed = parseGitHubRepo(repo);
  if (!parsed) {
    checks.push(check('repo-format', CHECK.FAIL,
      `"${repo}" is not an https github.com/owner/repo URL. Render can deploy other providers, ` +
      'but AGENTIQ only preflights GitHub repositories.'));
    return { checks, ok: false, needsGrant: false, parsed: null };
  }
  checks.push(check('repo-format', CHECK.PASS, `${parsed.owner}/${parsed.repo}`));

  // ── 2. service name: Render's constraint, checked before we waste a call ─
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(String(serviceName ?? ''))) {
    checks.push(check('service-name', CHECK.FAIL,
      `"${serviceName}" is not a valid Render service name. Use lowercase letters, digits and ` +
      'hyphens, starting and ending with an alphanumeric character.'));
  } else {
    checks.push(check('service-name', CHECK.PASS, serviceName));
  }

  /**
   * A refusal by the permission gate is NOT a transport failure and must not
   * degrade into a warn. "We were not allowed to look" and "we looked and it is
   * fine" are different answers, and reporting the first as the second would
   * let preflight bless a repository it never read.
   */
  let needsGrant = false;
  const denied = (err) => {
    if (err?.code !== 'PERMISSION_DENIED') return false;
    needsGrant = true;
    return true;
  };

  const gh = async (path) => runTool('http_request', {
    url: `${githubApi}${path}`,
    method: 'GET',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'agentiq-deployment-agent' },
  }, context);

  // ── 3. repo reachable ────────────────────────────────────────────────────
  let repoMeta = null;
  try {
    const res = await gh(`/repos/${parsed.owner}/${parsed.repo}`);
    if (res.status === 200) {
      repoMeta = JSON.parse(res.body);
      checks.push(check('repo-reachable', CHECK.PASS,
        `${repoMeta.full_name} is ${repoMeta.private ? 'private' : 'public'}` +
        `${repoMeta.private ? ': Render will need its own GitHub authorisation to clone it' : ''}.`));
    } else if (res.status === 404) {
      checks.push(check('repo-reachable', CHECK.FAIL,
        `GitHub returned 404 for ${parsed.owner}/${parsed.repo}. The repository does not exist, ` +
        'or it is private and AGENTIQ cannot see it anonymously.'));
    } else {
      checks.push(check('repo-reachable', CHECK.WARN,
        `GitHub returned ${res.status}; could not confirm the repository exists.`));
    }
  } catch (err) {
    checks.push(denied(err)
      ? check('repo-reachable', CHECK.FAIL,
        `Not checked: AGENTIQ has no permission to read ${new URL(githubApi).host} in this session.`)
      : check('repo-reachable', CHECK.WARN, `Could not reach GitHub: ${err.message}`));
  }

  // ── 4. branch exists ─────────────────────────────────────────────────────
  try {
    const res = await gh(`/repos/${parsed.owner}/${parsed.repo}/branches/${encodeURIComponent(branch)}`);
    if (res.status === 200) {
      const head = JSON.parse(res.body)?.commit?.sha?.slice(0, 7);
      checks.push(check('branch-exists', CHECK.PASS, `${branch} at ${head}`));
    } else if (res.status === 404) {
      checks.push(check('branch-exists', CHECK.FAIL,
        `Branch "${branch}" does not exist in ${parsed.owner}/${parsed.repo}.`));
    } else {
      checks.push(check('branch-exists', CHECK.WARN,
        `GitHub returned ${res.status}; could not confirm the branch exists.`));
    }
  } catch (err) {
    checks.push(denied(err)
      ? check('branch-exists', CHECK.FAIL, 'Not checked: no permission to read GitHub in this session.')
      : check('branch-exists', CHECK.WARN, `Could not check the branch: ${err.message}`));
  }

  // ── 5. the manifest actually supports the start command ──────────────────
  // This is the check that earns its keep. The most common Render failure is a
  // build that succeeds and a service that never binds a port, because there is
  // no start script. Catching it here costs one request; catching it on Render
  // costs a full build.
  if (runtime === 'node') {
    try {
      const res = await gh(
        `/repos/${parsed.owner}/${parsed.repo}/contents/package.json?ref=${encodeURIComponent(branch)}`,
      );
      if (res.status === 200) {
        const payload = JSON.parse(res.body);
        const pkg = JSON.parse(Buffer.from(payload.content ?? '', 'base64').toString('utf8'));
        if (pkg.scripts?.start) {
          checks.push(check('start-command', CHECK.PASS, `npm start → ${pkg.scripts.start}`));
        } else {
          checks.push(check('start-command', CHECK.FAIL,
            'package.json has no "start" script. Render would build the service and then fail to ' +
            'run it. Add one, or set an explicit start command.'));
        }
      } else if (res.status === 404) {
        checks.push(check('start-command', CHECK.FAIL,
          `No package.json on ${branch}. A node runtime needs one at the repository root.`));
      } else {
        checks.push(check('start-command', CHECK.WARN,
          `GitHub returned ${res.status}; could not read package.json.`));
      }
    } catch (err) {
      checks.push(denied(err)
        ? check('start-command', CHECK.FAIL, 'Not checked: no permission to read GitHub in this session.')
        : check('start-command', CHECK.WARN, `Could not parse package.json: ${err.message}`));
    }
  }

  // ── 6. environment variables: local compute ──────────────────────────────
  const entries = Object.entries(envVars ?? {});
  const looksSecret = entries.filter(([, v]) => SECRET_SHAPES.some((re) => re.test(String(v))));
  if (entries.some(([k]) => k.toUpperCase() === 'PORT')) {
    checks.push(check('env-vars', CHECK.WARN,
      'PORT is set explicitly. Render assigns the port and the app must read process.env.PORT; ' +
      'a fixed value will make the health check fail.'));
  } else if (looksSecret.length) {
    checks.push(check('env-vars', CHECK.WARN,
      `${looksSecret.length} value(s) look like live credentials (${looksSecret.map(([k]) => k).join(', ')}). ` +
      'They will be stored by Render. That is normal for a deployment: this is a reminder, not a fault.'));
  } else {
    checks.push(check('env-vars', CHECK.PASS,
      entries.length ? `${entries.length} variable(s) declared.` : 'None declared.'));
  }

  return {
    checks,
    // ok means "every check ran and none failed", never "nothing objected".
    ok: !checks.some((c) => c.status === CHECK.FAIL),
    needsGrant,
    parsed,
  };
}

const defaultSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * PHASE 2: the deploy itself. Every step is a separate audited tool call.
 *
 * `dryRun` renders the mutating requests without sending them, so the whole
 * pipeline can be exercised (and tested) without creating real infrastructure.
 */
export async function runDeploy({
  repo, branch = 'main', serviceName, runtime = 'node', plan = 'free', region = 'oregon',
  buildCommand = 'npm install', startCommand = 'npm start', envVars = {},
  dryRun = false,
  pollIntervalMs = 5_000,
  maxPolls = 60,
  runTool,
  context = {},
  sleep = defaultSleep,
}) {
  const steps = [];
  const call = async (input) => {
    const out = await runTool('deploy_service', { provider: 'render', ...input }, context);
    steps.push({ action: input.action, message: out.message, at: new Date() });
    return out;
  };

  // Whose Render account. Also the first real proof the credential works.
  const owner = await call({ action: 'find_owner' });

  const existing = await call({ action: 'find_service', serviceName });

  let serviceId = existing.serviceId;
  let deployId = null;

  if (!existing.existed) {
    const created = await call({
      action: 'create_service',
      serviceName, repo, branch, runtime, plan, region,
      buildCommand, startCommand, envVars,
      ownerId: owner.ownerId,
      dryRun,
    });
    if (created.dryRun) {
      return { dryRun: true, ok: true, steps, serviceId: null, deployId: null,
        liveUrl: null, deployStatus: null, plan: created.wouldSend };
    }
    serviceId = created.serviceId;
    deployId = created.deployId;
  }

  // An existing service, or a create that did not itself start a deploy.
  if (!deployId) {
    const triggered = await call({ action: 'trigger_deploy', serviceId, dryRun });
    if (triggered.dryRun) {
      return { dryRun: true, ok: true, steps, serviceId, deployId: null,
        liveUrl: null, deployStatus: null, plan: triggered.wouldSend };
    }
    deployId = triggered.deployId;
  }

  // ── poll ─────────────────────────────────────────────────────────────────
  let deployStatus = 'unknown';
  for (let i = 0; i < maxPolls; i += 1) {
    const status = await call({ action: 'deploy_status', serviceId, deployId });
    deployStatus = status.deployStatus;
    if (isTerminalStatus(deployStatus)) break;
    await sleep(pollIntervalMs);
  }

  if (!TERMINAL_SUCCESS.has(deployStatus)) {
    return {
      dryRun: false,
      ok: false,
      steps,
      serviceId,
      deployId,
      deployStatus,
      liveUrl: null,
      error: isTerminalStatus(deployStatus)
        ? `Render reported "${deployStatus}". The build or start command failed; check the ` +
          'service logs in the Render dashboard.'
        : `Deploy did not finish within ${(maxPolls * pollIntervalMs) / 1000}s (last status: ` +
          `"${deployStatus}"). It may still be building.`,
    };
  }

  const info = await call({ action: 'service_info', serviceId });

  return {
    dryRun: false,
    ok: true,
    steps,
    serviceId,
    deployId,
    deployStatus,
    liveUrl: info.liveUrl,
  };
}

export default { runPreflight, runDeploy };
