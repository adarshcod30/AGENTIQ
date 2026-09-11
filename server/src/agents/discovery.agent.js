/**
 * DISCOVERY AGENT: turn a workspace into a structured project model.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D. Like the other agents, this file performs
 * NO I/O of its own (server/tests/architecture.test.js enforces it). Every file
 * it reads and every route it discovers comes back through an MCP tool, so the
 * whole of discovery is audited exactly like a test run or a scan.
 *
 * Phase 1 is fully deterministic: framework from package.json, endpoints from
 * the AST, dependencies and scripts from the manifest. Inferring what an
 * endpoint is FOR needs the LLM and belongs to a later phase; this agent finds
 * the surface, it does not yet interpret it.
 */

/** Frameworks we recognise from a dependency name, most specific first. */
const FRAMEWORK_BY_DEP = [
  ['@nestjs/core', 'nestjs'],
  ['next', 'next'],
  ['fastify', 'fastify'],
  ['@hapi/hapi', 'hapi'],
  ['koa', 'koa'],
  ['express', 'express'],
];

/** Config files worth knowing about, and the flag each one sets. */
const CONFIG_FILES = [
  ['Dockerfile', 'hasDockerfile'],
  ['docker-compose.yml', 'hasDockerCompose'],
  ['docker-compose.yaml', 'hasDockerCompose'],
  ['.env.example', 'hasEnvExample'],
];

/** Reads and JSON-parses one workspace file through fs_read, or returns null. */
async function readJson(runTool, context, path) {
  try {
    const res = await runTool('fs_read', { path }, context);
    return JSON.parse(res.content);
  } catch {
    return null;
  }
}

/** Does a workspace file exist? Asked through fs_read so it stays audited. */
async function exists(runTool, context, path) {
  try {
    await runTool('fs_read', { path, maxBytes: 1 }, context);
    return true;
  } catch {
    return false;
  }
}

function detectFramework(pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const signals = [];
  let framework = 'unknown';
  for (const [dep, name] of FRAMEWORK_BY_DEP) {
    if (deps[dep]) {
      signals.push(`dependency: ${dep}@${deps[dep]}`);
      if (framework === 'unknown') framework = name;
    }
  }
  return { framework, signals };
}

/**
 * Python projects have no package.json, so their framework comes from the
 * requirements manifest. Adds a signal and returns fastapi / flask / null.
 */
async function detectPythonFramework(runTool, context, signals) {
  let framework = null;
  for (const file of ['requirements.txt', 'pyproject.toml']) {
    try {
      const res = await runTool('fs_read', { path: file }, context);
      const text = String(res.content).toLowerCase();
      if (!framework && /\bfastapi\b/.test(text)) { framework = 'fastapi'; signals.push(`dependency: fastapi (${file})`); }
      if (!framework && /\bflask\b/.test(text)) { framework = 'flask'; signals.push(`dependency: flask (${file})`); }
    } catch { /* no such manifest */ }
  }
  return framework;
}

function extractDependencies(pkg) {
  const out = [];
  for (const [name, version] of Object.entries(pkg?.dependencies ?? {})) {
    out.push({ name, version: String(version), dev: false });
  }
  for (const [name, version] of Object.entries(pkg?.devDependencies ?? {})) {
    out.push({ name, version: String(version), dev: true });
  }
  return out;
}

/**
 * Runs discovery. `runTool(name, input, extra)` invokes an MCP tool in the
 * project context (its workspaceRoot is injected by the caller, never by this
 * agent). Returns the project model, ready to persist.
 */
export async function runDiscoveryAgent({ runTool, context = {} }) {
  const pkg = await readJson(runTool, context, 'package.json');
  const { framework: pkgFramework, signals } = detectFramework(pkg);

  // The API surface: deterministic, no LLM (docs/10 §D acceptance criterion).
  // The tool now covers Express, FastAPI/Flask and Next, and reports which it saw.
  const routes = await runTool('discover_routes', {}, context);

  // Python projects declare their framework in a requirements manifest, not
  // package.json, so look there when the manifest did not settle it.
  const pyFramework = pkgFramework === 'unknown'
    ? await detectPythonFramework(runTool, context, signals)
    : null;

  const config = { packageManager: 'npm', hasDockerfile: false, hasDockerCompose: false, hasEnvExample: false };
  for (const [file, flag] of CONFIG_FILES) {
    if (await exists(runTool, context, file)) config[flag] = true;
  }
  if (await exists(runTool, context, 'pnpm-lock.yaml')) config.packageManager = 'pnpm';
  else if (await exists(runTool, context, 'yarn.lock')) config.packageManager = 'yarn';

  const endpoints = routes.endpoints ?? [];

  // Resolve the framework: the manifest wins; then the Python manifest; then
  // whatever the route extractor actually detected; then express if there are
  // endpoints at all; else unknown.
  const framework = pkgFramework !== 'unknown'
    ? pkgFramework
    : (pyFramework ?? routes.framework ?? (endpoints.length ? 'express' : 'unknown'));

  return {
    framework,
    frameworkSignals: signals,
    endpoints,
    endpointCount: endpoints.length,
    dependencies: extractDependencies(pkg),
    scripts: pkg?.scripts ?? {},
    config,
    stats: routes.stats ?? { filesScanned: 0, filesWithRoutes: 0, routesFound: 0, parseErrors: 0 },
  };
}

export default runDiscoveryAgent;
