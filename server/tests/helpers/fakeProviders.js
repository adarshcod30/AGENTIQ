/**
 * Scriptable stand-ins for the two external control planes the deployment agent
 * talks to: Render and GitHub.
 *
 * These are TEST DOUBLES, deliberately kept out of fixtures/: fixtures/ holds
 * the vulnerable and hardened APIs, which are part of the deliverable and whose
 * contract identity is itself under test. These are not that.
 *
 * They exist so the full F5 flow can be exercised end to end without creating
 * real infrastructure in a real Render account, and so CI needs no credential
 * and no outbound network access. Every request they receive is RECORDED, which
 * is what lets a test assert the thing that matters most: that a dry run sends
 * no mutating request, and that no API key is ever echoed anywhere.
 */
import express from 'express';

/** Starts an app on an ephemeral loopback port. */
export function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/**
 * A fake Render API.
 *
 * @param {object} opts
 * @param {string} opts.apiKey        the credential it will accept
 * @param {string[]} opts.statuses    deploy statuses returned in order by
 *                                    deploy_status; the last one repeats
 * @param {object[]} opts.services    services that already exist
 */
export function fakeRender({
  apiKey = 'rnd_test_key_abcdef123456', statuses = ['live'], services = [],
  liveUrl = 'http://127.0.0.1:1/unused',
} = {}) {
  const app = express();
  app.use(express.json());

  const state = {
    /** Every request, so tests can assert what was and was not sent. */
    requests: [],
    services: [...services],
    deploys: new Map(),
    pollCount: 0,
    apiKey,
    liveUrl,
  };

  app.use((req, res, next) => {
    state.requests.push({
      method: req.method,
      path: req.path,
      auth: req.get('authorization') ?? null,
      body: req.body,
    });
    if (req.get('authorization') !== `Bearer ${apiKey}`) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    return next();
  });

  app.get('/owners', (req, res) =>
    res.json([{ cursor: 'c1', owner: { id: 'usr-fake-001', name: 'Fake Owner' } }]));

  app.get('/services', (req, res) => {
    const name = String(req.query.name ?? '');
    // Render's filter is a prefix match; mirror that so the tool's exact-match
    // guard is genuinely exercised rather than trivially satisfied.
    const hits = state.services.filter((s) => s.name.startsWith(name));
    res.json(hits.map((service) => ({ cursor: 'c', service })));
  });

  app.post('/services', (req, res) => {
    const service = {
      id: `srv-${state.services.length + 1}`,
      name: req.body?.name,
      serviceDetails: { url: null },
    };
    state.services.push(service);
    res.status(201).json({ service, deployId: null });
  });

  app.post('/services/:id/deploys', (req, res) => {
    const id = `dep-${state.deploys.size + 1}`;
    state.deploys.set(id, { id, serviceId: req.params.id });
    res.status(201).json({ id, status: statuses[0] });
  });

  app.get('/services/:id/deploys/:deployId', (req, res) => {
    const status = statuses[Math.min(state.pollCount, statuses.length - 1)];
    state.pollCount += 1;
    res.json({ id: req.params.deployId, status });
  });

  app.get('/services/:id', (req, res) => {
    const service = state.services.find((s) => s.id === req.params.id)
      ?? { id: req.params.id, name: 'unknown' };
    res.json({
      service: { ...service, serviceDetails: { url: state.liveUrl } },
    });
  });

  return { app, state };
}

/**
 * A fake GitHub API covering only what preflight reads.
 *
 * @param {object} opts
 * @param {boolean} opts.repoExists
 * @param {boolean} opts.priv
 * @param {string[]} opts.branches
 * @param {object|null} opts.packageJson  null = no package.json on the branch
 */
export function fakeGitHub({
  repoExists = true, priv = false, branches = ['main'],
  packageJson = { name: 'demo', scripts: { start: 'node server.js' } },
} = {}) {
  const app = express();
  const state = { requests: [] };

  app.use((req, _res, next) => { state.requests.push({ method: req.method, path: req.path }); next(); });

  app.get('/repos/:owner/:repo', (req, res) => {
    if (!repoExists) return res.status(404).json({ message: 'Not Found' });
    return res.json({ full_name: `${req.params.owner}/${req.params.repo}`, private: priv });
  });

  app.get('/repos/:owner/:repo/branches/:branch', (req, res) => {
    if (!branches.includes(req.params.branch)) return res.status(404).json({ message: 'Branch not found' });
    return res.json({ name: req.params.branch, commit: { sha: 'abc1234def5678' } });
  });

  app.get('/repos/:owner/:repo/contents/package.json', (req, res) => {
    if (!packageJson) return res.status(404).json({ message: 'Not Found' });
    return res.json({
      name: 'package.json',
      encoding: 'base64',
      content: Buffer.from(JSON.stringify(packageJson)).toString('base64'),
    });
  });

  return { app, state };
}

/**
 * A fake Vercel API covering the deployments endpoints the provider uses.
 *
 * @param {object} opts
 * @param {string} opts.token       the bearer token it will accept
 * @param {string[]} opts.statuses  readyState values returned in order by the
 *                                  poll; the last one repeats
 * @param {string} opts.url         the deployment url returned (no scheme, as
 *                                  Vercel returns it)
 */
export function fakeVercel({
  token = 'vercel_test_token_abc123', statuses = ['READY'], url = 'demo-api-abc.vercel.app',
} = {}) {
  const app = express();
  app.use(express.json());
  const state = { requests: [], deploys: new Map(), pollCount: 0, token, url };

  app.use((req, res, next) => {
    state.requests.push({
      method: req.method, path: req.path, auth: req.get('authorization') ?? null, body: req.body,
    });
    if (req.get('authorization') !== `Bearer ${token}`) {
      return res.status(403).json({ error: { message: 'Forbidden' } });
    }
    return next();
  });

  app.post('/v13/deployments', (req, res) => {
    const id = `dpl_${state.deploys.size + 1}`;
    state.deploys.set(id, { id, name: req.body?.name, gitSource: req.body?.gitSource });
    res.status(200).json({ id, readyState: statuses[0], url: state.url, projectId: 'prj_fake' });
  });

  app.get('/v13/deployments/:id', (req, res) => {
    const status = statuses[Math.min(state.pollCount, statuses.length - 1)];
    state.pollCount += 1;
    res.json({ id: req.params.id, readyState: status, url: state.url, projectId: 'prj_fake' });
  });

  return { app, state };
}
