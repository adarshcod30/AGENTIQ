/**
 * Risk classes and the permission gate.
 *
 * docs/02_TRD.md §5.2. This is the part of the architecture that separates "an
 * LLM that fires HTTP requests on your behalf" from a tool layer with real,
 * reviewable controls.
 *
 * Grants are per RISK CLASS and per HOST, not per tool (docs/01_PRD.md F1).
 * Asking a user to approve every tool individually is theatre: they will click
 * through it. Asking them to approve
 * "this app may send attack-indicator payloads to api.example.com" is a real
 * decision a human can actually make.
 */

export const RISK_CLASS = {
  LOCAL_COMPUTE: 'local.compute',
  LOCAL_FS_READ: 'local.fs.read',
  LOCAL_PROCESS: 'local.process',
  NETWORK_READ: 'network.read',
  NETWORK_PROBE: 'network.probe',
  DEPLOY_WRITE: 'deploy.write',
};

export const RISK_CLASSES = Object.values(RISK_CLASS);

/** Human-facing copy for the permission sheet (docs/03_App_Flow.md B1). */
export const RISK_CLASS_META = {
  [RISK_CLASS.LOCAL_COMPUTE]: {
    label: 'Local computation',
    description: 'Parsing and evaluation only. No network access.',
    autoGranted: true,
    requiresHost: false,
    requiresConfirmation: false,
  },
  [RISK_CLASS.LOCAL_FS_READ]: {
    label: 'Read the project workspace',
    description:
      'Reads files inside the one project workspace under assessment, and nowhere else. ' +
      'The filesystem jail (mcp/fsJail.js) enforces the boundary, which is why this is ' +
      'safe to auto-grant: a tool cannot read outside the workspace root it was given.',
    autoGranted: true,
    requiresHost: false,
    requiresConfirmation: false,
  },
  [RISK_CLASS.LOCAL_PROCESS]: {
    label: 'Run the project locally',
    description:
      'Starts, health-checks and stops the project under assessment as a local process, on ' +
      'loopback only. The process sandbox (mcp/procSandbox.js) enforces the boundary: no shell, ' +
      'an allowlisted runner, the workspace as the working directory, and a scrubbed environment ' +
      'that never carries AGENTIQ secrets. In local mode this runs the user\'s own code.',
    autoGranted: true,
    requiresHost: false,
    requiresConfirmation: false,
  },
  [RISK_CLASS.NETWORK_READ]: {
    label: 'Read from the target',
    description: 'Benign requests to a host you nominate, reading the response.',
    autoGranted: false,
    requiresHost: true,
    requiresConfirmation: false,
  },
  [RISK_CLASS.NETWORK_PROBE]: {
    label: 'Send attack-indicator payloads',
    description:
      'Sends SQL-injection and XSS indicator payloads to a host you nominate. ' +
      'Only scan hosts you own or are authorised to test.',
    autoGranted: false,
    requiresHost: true,
    requiresConfirmation: false,
  },
  [RISK_CLASS.DEPLOY_WRITE]: {
    label: 'Deploy infrastructure',
    description: 'Creates or triggers a deployment. Changes systems outside AGENTIQ.',
    autoGranted: false,
    requiresHost: false,
    requiresConfirmation: true,
  },
};

export class PermissionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PermissionError';
    this.code = 'PERMISSION_DENIED';
    this.details = details;
  }
}

const key = (userId, sessionId) => `${userId}::${sessionId}`;
const normaliseHost = (host) => String(host ?? '').trim().toLowerCase() || null;

/**
 * Session-scoped grants.
 *
 * In memory by design: a grant must not outlive the session that gave it.
 * Persisting them would mean a user who once approved probe traffic to a host
 * silently keeps that approval forever, which is precisely the "unaccountable
 * automation" problem in docs/01_PRD.md §2.
 */
export class GrantStore {
  constructor({ ttlMs = 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.grants = new Map();
  }

  #bucket(userId, sessionId) {
    const k = key(userId, sessionId);
    if (!this.grants.has(k)) this.grants.set(k, []);
    return this.grants.get(k);
  }

  /**
   * Records an explicit grant. `confirmed` is required for deploy.write and is
   * deliberately separate from the grant itself: approving the class is not
   * the same as approving a specific irreversible action.
   */
  grant({ userId, sessionId, riskClass, host = null, confirmed = false, now = Date.now() }) {
    if (!RISK_CLASSES.includes(riskClass)) {
      throw new PermissionError(`Unknown risk class: ${riskClass}`, { riskClass });
    }
    const meta = RISK_CLASS_META[riskClass];
    if (meta.requiresHost && !normaliseHost(host)) {
      throw new PermissionError(`${riskClass} requires a host`, { riskClass });
    }
    const entry = {
      riskClass,
      host: normaliseHost(host),
      confirmed: Boolean(confirmed),
      grantedAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.#bucket(userId, sessionId).push(entry);
    return entry;
  }

  revoke({ userId, sessionId, riskClass, host = null }) {
    const k = key(userId, sessionId);
    const before = this.grants.get(k)?.length ?? 0;
    const h = normaliseHost(host);
    this.grants.set(
      k,
      (this.grants.get(k) ?? []).filter(
        (g) => !(g.riskClass === riskClass && (h === null || g.host === h)),
      ),
    );
    return before - (this.grants.get(k)?.length ?? 0);
  }

  list({ userId, sessionId, now = Date.now() }) {
    return (this.grants.get(key(userId, sessionId)) ?? []).filter((g) => g.expiresAt > now);
  }

  /**
   * The gate itself.
   *
   * `local.compute` is auto-granted because it cannot reach the network: there
   * is nothing for a user to meaningfully consent to.
   *
   * `network.probe` is NEVER auto-granted, under any configuration. Firing SQLi
   * payloads at a host the user did not knowingly nominate is the one mistake in
   * this project that would be genuinely serious rather than merely embarrassing.
   */
  check({ userId, sessionId, riskClass, host = null, now = Date.now() }) {
    const meta = RISK_CLASS_META[riskClass];
    if (!meta) {
      return { allowed: false, reason: `Unknown risk class: ${riskClass}` };
    }

    if (meta.autoGranted) return { allowed: true, reason: 'auto-granted', grant: null };

    const h = normaliseHost(host);
    if (meta.requiresHost && !h) {
      return { allowed: false, reason: `${riskClass} requires a target host` };
    }

    // The MOST RECENT matching grant wins, not the first one found.
    //
    // Grants accumulate, so a user who approves a class twice has two entries.
    // Taking the first would mean a later confirmation never takes effect
    // (denying when it should allow) AND, worse, that a later downgrade never
    // takes effect either: a confirmed deploy.write would outlive the decision
    // to withdraw it. Latest decision wins, in both directions.
    const matches = this.list({ userId, sessionId, now }).filter(
      (g) => g.riskClass === riskClass && (!meta.requiresHost || g.host === h),
    );
    const match = matches.length ? matches[matches.length - 1] : undefined;

    if (!match) {
      return {
        allowed: false,
        reason: meta.requiresHost
          ? `No ${riskClass} grant for ${h}. The user must approve this host for this session.`
          : `No ${riskClass} grant for this session.`,
      };
    }

    if (meta.requiresConfirmation && !match.confirmed) {
      return { allowed: false, reason: `${riskClass} requires explicit confirmation.` };
    }

    return { allowed: true, reason: 'granted', grant: match };
  }

  clear() {
    this.grants.clear();
  }
}

export const grantStore = new GrantStore();
