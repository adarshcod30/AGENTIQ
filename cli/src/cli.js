/**
 * AGENTIQ CLI: scan a folder on your own machine and follow the assessment from
 * the terminal. It talks to the same hosted API the website uses, so a scan you
 * start here shows up in your dashboard too.
 *
 * No runtime dependencies: Node's built-in fetch, fs, and readline only.
 */
import readline from 'node:readline';
import { loadConfig, saveConfig, clearConfig, CONFIG_FILE, DEFAULT_API, DEFAULT_WEB } from './config.js';
import { api } from './api.js';
import { readFolder } from './folder.js';

const isTTY = Boolean(process.stdout.isTTY);
const paint = (code, s) => (isTTY ? `[${code}m${s}[0m` : s);
const bold = (s) => paint('1', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Minimal flag parser: `--key value`, `--flag`, and positionals in `_`. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; } else { out[key] = next; i += 1; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function question(query, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (!rl.muted) rl.output.write(s); };
      process.stdout.write(query);
      rl.muted = true;
    }
    rl.question(hidden ? '' : query, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function requireAuth(cfg) {
  if (!cfg.token) {
    throw new Error('You are not logged in. Run `agentiq login` first.');
  }
}

function dashUrl(cfg, id) {
  return `${cfg.webBase || DEFAULT_WEB}/assessments/${id}`;
}

async function cmdLogin(args) {
  const cfg = loadConfig();
  const apiBase = args.api || cfg.apiBase || DEFAULT_API;

  if (args.token) {
    saveConfig({ ...cfg, apiBase, token: String(args.token) });
    const me = await api(apiBase, 'GET', '/auth/me', { token: String(args.token) }).catch(() => null);
    console.log(green(`Saved token${me?.user?.email ? ` for ${me.user.email}` : ''}.`));
    return;
  }

  const email = args.email || await question('Email: ');
  const password = args.password || process.env.AGENTIQ_PASSWORD || await question('Password: ', { hidden: true });
  if (!email || !password) throw new Error('Email and password are required.');

  const data = await api(apiBase, 'POST', '/auth/login', { body: { email, password } });
  if (!data.token) throw new Error('Login did not return a token. Check your credentials.');
  saveConfig({ ...cfg, apiBase, token: data.token });
  console.log(green(`Logged in as ${data.user?.email || email}.`));
  console.log(dim(`Token saved to ${CONFIG_FILE}`));
}

async function cmdLogout() {
  clearConfig();
  console.log('Logged out.');
}

async function cmdWhoami() {
  const cfg = loadConfig();
  requireAuth(cfg);
  const me = await api(cfg.apiBase, 'GET', '/auth/me', { token: cfg.token });
  console.log(me.user?.email || JSON.stringify(me));
}

function severityCounts(findings = []) {
  const c = {};
  for (const f of findings) {
    const s = String(f.severity || 'unknown').toLowerCase();
    c[s] = (c[s] || 0) + 1;
  }
  return c;
}

function printSummary(a, cfg, id) {
  console.log('');
  console.log(bold(`Assessment ${a.state === 'COMPLETE' ? green('COMPLETE') : red(a.state)}`));

  const findings = a.security?.findings || a.findings || [];
  const counts = severityCounts(findings);
  const order = ['critical', 'high', 'medium', 'low', 'info', 'unknown'];
  const shown = order.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  console.log(`Security findings: ${findings.length ? shown.join(', ') : green('none')}`);

  const r = a.readiness || {};
  if (r.ready) {
    console.log(green('Readiness: ready to deploy'));
  } else {
    console.log(yellow('Readiness: not ready'));
  }
  for (const b of r.blockers || []) console.log(red(`  blocker: ${b}`));
  for (const w of (r.warnings || []).slice(0, 5)) console.log(yellow(`  warning: ${w}`));

  console.log('');
  console.log(`Full report: ${bold(dashUrl(cfg, id))}`);
}

async function cmdScan(args) {
  const cfg = loadConfig();
  requireAuth(cfg);

  const dir = args._[0] || '.';
  const { name, files, skipped } = readFolder(dir);
  if (!files.length) throw new Error(`No readable source files found in ${dir} (build output and binaries are skipped).`);

  console.log(`Uploading ${bold(String(files.length))} files from ${dir} ${dim(`(${skipped} skipped)`)}...`);
  const { project } = await api(cfg.apiBase, 'POST', '/projects/upload', {
    token: cfg.token, body: { name: args.name || name, files },
  });
  console.log(`Project ${green(project.name)} created.`);

  const { assessment } = await api(cfg.apiBase, 'POST', '/assessments', {
    token: cfg.token, body: { projectId: project.id },
  });
  const id = assessment._id || assessment.id;
  console.log(`Assessment ${dim(id)} started.`);

  if (args['no-wait']) {
    console.log(`Follow it at ${bold(dashUrl(cfg, id))}`);
    return;
  }

  const TERMINAL = new Set(['COMPLETE', 'FAILED']);
  const deadline = Date.now() + 10 * 60 * 1000; // give up watching after 10 minutes
  let a = assessment;
  let lastState = '';
  while (!TERMINAL.has(a.state)) {
    if (a.state !== lastState) {
      process.stdout.write(`${lastState ? '\n' : ''}${dim(a.state.toLowerCase())} `);
      lastState = a.state;
    } else {
      process.stdout.write(dim('.'));
    }
    if (Date.now() > deadline) {
      console.log(`\nStill running. Follow it at ${bold(dashUrl(cfg, id))}`);
      return;
    }
    await sleep(3000);
    const r = await api(cfg.apiBase, 'GET', `/assessments/${id}`, { token: cfg.token });
    a = r.assessment;
  }
  printSummary(a, cfg, id);
  if (a.state === 'FAILED') process.exitCode = 1;
}

const HELP = `${bold('agentiq')} - scan a local project folder with AGENTIQ

${bold('Usage')}
  agentiq login [--api <url>] [--email <e>] [--token <t>]
  agentiq scan [dir] [--name <name>] [--no-wait]
  agentiq whoami
  agentiq logout

${bold('Examples')}
  agentiq login                     ${dim('# sign in with your AGENTIQ email and password')}
  agentiq scan .                    ${dim('# scan the current folder, wait for the report')}
  agentiq scan ./my-api --no-wait   ${dim('# start a scan and print the dashboard link')}

Your folder's source is uploaded and statically scanned; it is never run on the
server. Set ${bold('AGENTIQ_API')} to point at a different backend.`;

export async function run(argv) {
  const args = parseArgs(argv);
  const cmd = args._.shift();
  try {
    switch (cmd) {
      case 'login': await cmdLogin(args); break;
      case 'logout': await cmdLogout(); break;
      case 'whoami': await cmdWhoami(); break;
      case 'scan': await cmdScan(args); break;
      case undefined:
      case 'help':
      case '--help':
      case '-h': console.log(HELP); break;
      default:
        console.error(red(`Unknown command: ${cmd}`));
        console.log(HELP);
        process.exitCode = 2;
    }
  } catch (err) {
    console.error(red(`Error: ${err.message}`));
    process.exitCode = 1;
  }
}
