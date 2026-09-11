/**
 * Deployment failure diagnosis.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D. When a build or start fails, classify it
 * from the logs, explain it, and propose a fix. A `safeFix` that changes
 * behaviour (setting an env var, changing a command) is a PROPOSAL that needs
 * the user's approval, never an automatic edit: the plan is explicit that
 * behaviour-changing fixes are approval-gated.
 */

const RULES = [
  {
    classification: 'missing-env-var',
    re: /\b(?:missing|required|undefined)\b[^\n]*\b(?:env(?:ironment)?[\s-]?var(?:iable)?|process\.env)\b|process\.env\.([A-Z][A-Z0-9_]+)[^\n]*(?:undefined|not set|is required)/i,
    explain: 'The app expects an environment variable that is not set on the host.',
    suggest: (m) => `Set the environment variable${m[1] ? ` ${m[1]}` : ''} on the deployment and redeploy.`,
    safeFix: (m) => ({ type: 'env-var', key: m[1] ?? null, behaviourChanging: true }),
  },
  {
    classification: 'missing-start-script',
    re: /missing script:\s*start|no start (?:script|command)|npm ERR!\s*missing script/i,
    explain: 'There is no start script, so the host does not know how to run the app.',
    suggest: () => 'Add a "start" script to package.json (for example "node src/index.js").',
    safeFix: () => ({ type: 'start-command', behaviourChanging: true }),
  },
  {
    classification: 'missing-dependency',
    re: /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i,
    explain: 'A required module could not be found, usually a dependency missing from package.json or an install that did not run.',
    suggest: () => 'Ensure the module is a dependency in package.json and that the build runs npm install.',
    safeFix: () => null,
  },
  {
    classification: 'port-binding',
    re: /EADDRINUSE|address already in use|listen EACCES|did not open (?:a )?port|no open ports detected/i,
    explain: 'The app did not bind the port the host provides. Most hosts pass the port in the PORT environment variable.',
    suggest: () => 'Bind to process.env.PORT (falling back to a default) rather than a hardcoded port.',
    safeFix: () => ({ type: 'use-port-env', behaviourChanging: true }),
  },
  {
    classification: 'build-error',
    re: /build failed|error TS\d+|SyntaxError|tsc: command not found/i,
    explain: 'The build step failed before the app could start.',
    suggest: () => 'Check the build command and that all build dependencies are installed.',
    safeFix: () => null,
  },
];

/**
 * Classifies a deployment failure from its logs.
 * @returns {{ classification, explanation, suggestion, safeFix }}
 */
export function diagnoseFailure(logText, requirements = {}) {
  const text = String(logText ?? '');
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) {
      return {
        classification: rule.classification,
        explanation: rule.explain,
        suggestion: rule.suggest(m, requirements),
        safeFix: rule.safeFix(m, requirements),
      };
    }
  }
  return {
    classification: 'unknown',
    explanation: 'The deployment failed for a reason the diagnostics did not recognise.',
    suggestion: 'Read the build logs above for the first error, and check the build and start commands.',
    safeFix: null,
  };
}
