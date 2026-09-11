/**
 * Secret detection: hardcoded credentials in the source.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §6, §7. Pure: given files as { path, content },
 * it returns findings. A focused, high-signal ruleset (provider key shapes and
 * obvious credential assignments), not an entropy scanner, so the false-positive
 * rate stays low. The matched secret is masked in the evidence, so the report
 * never itself becomes the leak.
 */
import { makeFinding, SEVERITY, CONFIDENCE, LANE } from './findings.js';

/** Files that are meant to hold placeholders, not real secrets. */
const SKIP_FILE = /(^|\/)(\.env\.example|\.env\.sample|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;

const RULES = [
  { category: 'aws-access-key', severity: SEVERITY.CRITICAL, re: /\bAKIA[0-9A-Z]{16}\b/, title: 'AWS access key id' },
  { category: 'private-key', severity: SEVERITY.CRITICAL, re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, title: 'Private key material' },
  { category: 'google-api-key', severity: SEVERITY.HIGH, re: /\bAIza[0-9A-Za-z_-]{35}\b/, title: 'Google API key' },
  { category: 'google-oauth-secret', severity: SEVERITY.HIGH, re: /\bGOCSPX-[0-9A-Za-z_-]{20,}\b/, title: 'Google OAuth client secret' },
  { category: 'slack-token', severity: SEVERITY.HIGH, re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, title: 'Slack token' },
  { category: 'stripe-key', severity: SEVERITY.HIGH, re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/, title: 'Stripe live key' },
  { category: 'jwt', severity: SEVERITY.MEDIUM, re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, title: 'Hardcoded JWT' },
  { category: 'mongo-uri-with-password', severity: SEVERITY.HIGH, re: /\bmongodb(?:\+srv)?:\/\/[^\s:@]+:[^\s:@]{4,}@/, title: 'MongoDB URI with an inline password' },
  {
    category: 'assigned-secret',
    severity: SEVERITY.MEDIUM,
    // secret/password/apikey/token = "a non-trivial literal", excluding obvious placeholders.
    re: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"`]([^'"`\s]{8,})['"`]/i,
    title: 'Hardcoded credential in an assignment',
    placeholder: /^(?:changeme|your[_-]?|example|placeholder|xxx+|<[^>]+>|\$\{|process\.env|null|undefined|true|false)/i,
  },
];

/** Masks all but the first and last two characters of a matched secret. */
export function mask(secret) {
  const s = String(secret);
  if (s.length <= 6) return '***';
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/** Scans one file's content. Returns findings. */
export function scanContentForSecrets(path, content) {
  if (SKIP_FILE.test(path)) return [];
  const lines = String(content).split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const captured = m[1] ?? m[0];
      if (rule.placeholder && rule.placeholder.test(captured)) continue;
      findings.push(makeFinding({
        lane: LANE.SECRETS,
        category: rule.category,
        severity: rule.severity,
        confidence: CONFIDENCE.STRONG,
        title: rule.title,
        description: 'A credential appears to be hardcoded in the source. Anyone with the code has it, and it survives in git history even after removal.',
        evidence: `${path}:${i + 1}  ${line.trim().replace(captured, mask(captured)).slice(0, 200)}`,
        remediation: 'Move it to an environment variable or a secret manager, and rotate the exposed value.',
        location: { file: path, line: i + 1 },
      }));
    }
  }
  return findings;
}

/** Scans many files: [{ path, content }] -> findings. */
export function scanSecrets(files) {
  return files.flatMap((f) => scanContentForSecrets(f.path, f.content));
}
