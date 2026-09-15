/**
 * Where the CLI keeps who you are between commands: the API base and your token.
 *
 * Stored in ~/.agentiq/config.json with owner-only permissions, because it holds
 * a bearer token. Nothing here talks to the network; it is just the on-disk seam.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API = process.env.AGENTIQ_API || 'https://agentiq.duckdns.org/api';
export const DEFAULT_WEB = process.env.AGENTIQ_WEB || 'https://agentiq-adarshcod30s-projects.vercel.app';

const DIR = path.join(os.homedir(), '.agentiq');
const FILE = path.join(DIR, 'config.json');

export function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { apiBase: DEFAULT_API, webBase: DEFAULT_WEB, ...cfg };
  } catch {
    return { apiBase: DEFAULT_API, webBase: DEFAULT_WEB };
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  // 0600: the file holds a token, so no other user on the machine should read it.
  fs.writeFileSync(FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort on platforms without chmod */ }
}

export function clearConfig() {
  try { fs.rmSync(FILE); } catch { /* already gone */ }
}

export { FILE as CONFIG_FILE };
