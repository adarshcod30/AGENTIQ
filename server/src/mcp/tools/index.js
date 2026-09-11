/**
 * Registers all nine tools.
 *
 * Importing a tool module registers it as a side effect, so this file is the
 * single place that decides what the server exposes. Import it once at boot;
 * `registerAllTools()` is idempotent so tests can call it freely.
 *
 * docs/01_PRD.md F1 lists exactly these nine.
 */
import { TOOLS } from '../registry.js';

let registered = false;

export async function registerAllTools() {
  if (registered) return TOOLS;
  registered = true;

  await Promise.all([
    import('./http_request.js'),
    import('./run_test_case.js'),
    import('./probe_sqli.js'),
    import('./probe_xss.js'),
    import('./probe_auth.js'),
    import('./probe_cors.js'),
    import('./probe_headers.js'),
    import('./parse_openapi.js'),
    import('./deploy_service.js'),
  ]);

  return TOOLS;
}

/** The names the registry must expose. Asserted by the registry test. */
export const EXPECTED_TOOLS = [
  'http_request',
  'run_test_case',
  'probe_sqli',
  'probe_xss',
  'probe_auth',
  'probe_cors',
  'probe_headers',
  'parse_openapi',
  'deploy_service',
];

export default registerAllTools;
