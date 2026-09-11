/**
 * Static source analysis: risky code patterns.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §6. Pure: files as { path, content } in,
 * findings out. A focused, high-signal ruleset for the weaknesses a regex can
 * catch honestly (injection sinks, command execution, eval, weak crypto, raw
 * redirects). The plan is explicit that a real Semgrep ruleset beats this;
 * sast_scan uses Semgrep when it is installed and falls back to these patterns.
 *
 * Confidence is POTENTIAL by default: a pattern is a lead, not a proof. The
 * report says so, and the DAST lane is what upgrades a lead to CONFIRMED.
 */
import { makeFinding, SEVERITY, CONFIDENCE, LANE } from './findings.js';

const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git)\//;

const RULES = [
  {
    category: 'sql-injection', severity: SEVERITY.HIGH, owasp: 'API8:2023',
    re: /(?:query|execute|raw)\s*\(\s*[`'"][^`'"]*\$\{|(?:SELECT|INSERT|UPDATE|DELETE)\b[^;]*\+\s*\w/i,
    title: 'Possible SQL injection: a query built by string concatenation or interpolation',
    remediation: 'Use parameterised queries or an ORM binding, never string-built SQL.',
  },
  {
    category: 'command-injection', severity: SEVERITY.CRITICAL, owasp: 'API8:2023',
    // Catches the three shapes that actually appear: a template literal with
    // interpolation (exec(`ls ${x}`)), a string literal then concatenation
    // (exec("ls " + x)), and a bare variable then concatenation (exec(cmd + x)).
    // The string-literal-then-concat shape is the textbook one, and the earlier
    // pattern missed it.
    re: /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*(?:[`'"][^`'"]*(?:\$\{|[`'"]\s*\+)|\w+\s*\+)/,
    title: 'Possible command injection: a shell command built from a variable',
    remediation: 'Pass arguments as an array to spawn, never build a shell string from input.',
  },
  {
    category: 'code-eval', severity: SEVERITY.HIGH, owasp: 'API8:2023',
    re: /\beval\s*\(|new Function\s*\(|\bvm\.runIn/,
    title: 'Dynamic code evaluation (eval / new Function)',
    remediation: 'Remove dynamic evaluation. It turns any controlled input into code execution.',
  },
  {
    category: 'path-traversal', severity: SEVERITY.HIGH, owasp: 'API1:2023',
    re: /(?:readFile|readFileSync|createReadStream|sendFile)\s*\([^)]*\breq\.(?:params|query|body)/,
    title: 'Possible path traversal: a filesystem path from the request',
    remediation: 'Resolve and confine the path to an allowed base directory before reading.',
  },
  {
    category: 'weak-hash', severity: SEVERITY.MEDIUM, owasp: 'API8:2023',
    re: /createHash\s*\(\s*['"`](?:md5|sha1)['"`]/i,
    title: 'Weak hash algorithm (MD5 or SHA-1)',
    remediation: 'Use SHA-256 or better; for passwords use bcrypt, scrypt or argon2.',
  },
  {
    category: 'open-redirect', severity: SEVERITY.MEDIUM, owasp: 'API1:2023',
    re: /res\.redirect\s*\(\s*req\.(?:query|params|body)/,
    title: 'Possible open redirect: redirecting to a request-controlled URL',
    remediation: 'Redirect only to an allow-listed set of paths, never to a raw request value.',
  },
  {
    category: 'insecure-random', severity: SEVERITY.LOW, owasp: 'API8:2023',
    re: /Math\.random\s*\(\)/,
    title: 'Math.random used where a value may need to be unguessable',
    remediation: 'For tokens or ids use crypto.randomUUID or crypto.randomBytes.',
    onlyIf: /token|secret|password|otp|nonce|session|csrf/i, // near a security word on the line
  },
];

/** Scans one file's content for the ruleset. */
export function scanContentForSast(path, content) {
  if (SKIP.test(`/${path}`)) return [];
  const lines = String(content).split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue;
      if (rule.onlyIf && !rule.onlyIf.test(line)) continue;
      findings.push(makeFinding({
        lane: LANE.SAST,
        category: rule.category,
        severity: rule.severity,
        confidence: CONFIDENCE.POTENTIAL,
        title: rule.title,
        owasp: rule.owasp,
        description: 'A static pattern matched here. It is a lead worth checking, not a proof; a dynamic probe or a human confirms it.',
        evidence: `${path}:${i + 1}  ${line.trim().slice(0, 200)}`,
        remediation: rule.remediation,
        location: { file: path, line: i + 1 },
      }));
    }
  }
  return findings;
}

/** Scans many files: [{ path, content }] -> findings. */
export function scanSource(files) {
  return files.flatMap((f) => scanContentForSast(f.path, f.content));
}
