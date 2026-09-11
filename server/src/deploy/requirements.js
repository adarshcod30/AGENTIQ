/**
 * Deployment requirement detection.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D. Provider-agnostic: given a project's
 * package.json (and optionally the env keys it declares), work out the runtime,
 * the build and start commands, and which environment variables it will need.
 * Every provider reuses this, then maps the result onto its own API.
 */

/** Detects deployment requirements from a package.json object. */
export function detectRequirements(pkg, { envKeys = [], hasDockerfile = false } = {}) {
  const scripts = pkg?.scripts ?? {};
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };

  const runtime = hasDockerfile ? 'docker' : 'node';

  // Build: run a build script when one exists, otherwise just install.
  const buildCommand = scripts.build ? 'npm install && npm run build' : 'npm install';

  // Start: prefer an explicit start script, then a serve, then a dev script.
  let startCommand = null;
  if (scripts.start) startCommand = 'npm start';
  else if (scripts.serve) startCommand = 'npm run serve';
  else if (scripts.dev) startCommand = 'npm run dev';

  // A rough framework label, for the report and the UI.
  let framework = 'node';
  if (deps.next) framework = 'next';
  else if (deps['@nestjs/core']) framework = 'nestjs';
  else if (deps.express) framework = 'express';
  else if (deps.fastify) framework = 'fastify';

  const warnings = [];
  if (!startCommand && !hasDockerfile) {
    warnings.push('No start, serve or dev script and no Dockerfile: the platform will not know how to run this app.');
  }

  return {
    runtime,
    framework,
    buildCommand,
    startCommand,
    envVars: [...new Set(envKeys)],
    hasDockerfile,
    warnings,
  };
}
