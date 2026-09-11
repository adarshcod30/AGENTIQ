/**
 * Configuration analysis: insecure settings in app and container config.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §6. Pure: given the workspace files it cares
 * about, it returns findings. Covers the settings that most often ship wrong in
 * a student or hobby project: a permissive CORS policy, missing security
 * headers, a committed .env, and a Dockerfile that runs as root or pins latest.
 */
import { makeFinding, SEVERITY, CONFIDENCE, LANE } from './findings.js';

/** Scans source text (any JS/TS) for insecure Express and CORS configuration. */
export function scanAppConfig(files) {
  const findings = [];
  const all = files.map((f) => f.content).join('\n');

  const usesExpress = /\bexpress\b/.test(all);
  if (usesExpress && !/\bhelmet\s*\(/.test(all)) {
    findings.push(makeFinding({
      lane: LANE.CONFIG, category: 'missing-security-headers', severity: SEVERITY.MEDIUM,
      confidence: CONFIDENCE.STRONG, owasp: 'API8:2023',
      title: 'Express app without helmet: security headers are not set',
      description: 'Without helmet (or equivalent), responses lack CSP, HSTS, X-Content-Type-Options and X-Frame-Options.',
      remediation: 'Add app.use(helmet()) near the top of the middleware chain.',
    }));
  }

  for (const f of files) {
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // CORS reflecting any origin together with credentials.
      if (/origin\s*:\s*true/.test(line) && /credentials\s*:\s*true/.test(f.content)) {
        findings.push(makeFinding({
          lane: LANE.CONFIG, category: 'cors-permissive', severity: SEVERITY.HIGH,
          confidence: CONFIDENCE.STRONG, owasp: 'API8:2023',
          title: 'CORS reflects any origin with credentials enabled',
          description: 'Reflecting the request origin while allowing credentials lets any site make authenticated cross-origin requests.',
          evidence: `${f.path}:${i + 1}  ${line.trim().slice(0, 160)}`,
          remediation: 'Set an explicit allow-list of origins; never combine a reflected origin with credentials.',
          location: { file: f.path, line: i + 1 },
        }));
      }
      if (/Access-Control-Allow-Origin['"`]?\s*[,:]\s*['"`]\*/.test(line)) {
        findings.push(makeFinding({
          lane: LANE.CONFIG, category: 'cors-wildcard', severity: SEVERITY.MEDIUM,
          confidence: CONFIDENCE.STRONG, owasp: 'API8:2023',
          title: 'Access-Control-Allow-Origin: *',
          description: 'A wildcard CORS origin exposes the API to every website.',
          evidence: `${f.path}:${i + 1}  ${line.trim().slice(0, 160)}`,
          remediation: 'Restrict the origin to the domains that need access.',
          location: { file: f.path, line: i + 1 },
        }));
      }
    }
  }
  return findings;
}

/** Flags a committed .env (real secrets), distinct from .env.example. */
export function scanCommittedEnv(paths) {
  return paths
    .filter((p) => /(^|\/)\.env$/.test(p) || /(^|\/)\.env\.(?!example|sample)[a-z]+$/.test(p))
    .map((p) => makeFinding({
      lane: LANE.CONFIG, category: 'committed-env', severity: SEVERITY.HIGH,
      confidence: CONFIDENCE.STRONG,
      title: `A .env file is present in the workspace: ${p}`,
      description: 'A committed .env usually carries real secrets. If it is tracked by git, those secrets are in history.',
      remediation: 'Remove it from version control, add .env to .gitignore, and rotate anything it held.',
      location: { file: p },
    }));
}

/** Scans a Dockerfile for the common insecure defaults. */
export function scanDockerfile(path, content) {
  if (!content) return [];
  const findings = [];
  const hasUser = /^\s*USER\s+(?!root\b)\S+/im.test(content);
  if (!hasUser) {
    findings.push(makeFinding({
      lane: LANE.CONFIG, category: 'docker-root', severity: SEVERITY.MEDIUM, confidence: CONFIDENCE.STRONG,
      title: 'Dockerfile runs as root (no non-root USER)',
      description: 'A container running as root widens the blast radius of any code-execution bug.',
      remediation: 'Add a non-root USER before the CMD.',
      location: { file: path },
    }));
  }
  const latest = /^\s*FROM\s+\S+:latest/im.exec(content) || /^\s*FROM\s+[^\s:@]+\s*$/im.exec(content);
  if (latest) {
    findings.push(makeFinding({
      lane: LANE.CONFIG, category: 'docker-latest', severity: SEVERITY.LOW, confidence: CONFIDENCE.POTENTIAL,
      title: 'Dockerfile base image is unpinned (latest)',
      description: 'An unpinned base image makes builds non-reproducible and can pull in changes silently.',
      remediation: 'Pin the base image to a specific version or digest.',
      location: { file: path },
    }));
  }
  return findings;
}
