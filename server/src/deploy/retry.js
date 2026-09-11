/**
 * Turning a failure diagnosis into a retry proposal.
 *
 * docs/10_AUTONOMOUS_PLATFORM.md §D, §I. The plan draws a hard line: the platform
 * may set deployment configuration on the user's behalf (with approval), but it
 * must never edit their code automatically. This is where that line is drawn.
 *
 *   - A missing environment variable is a CONFIG fix. AGENTIQ can set it on the
 *     service and redeploy, once the user supplies the value and approves. No
 *     code changes.
 *   - A missing start script, a hardcoded port, a missing dependency, a build
 *     error: these are CODE fixes. The proposal explains what to change, and the
 *     user changes it and redeploys. The platform does not touch the repository.
 *
 * So `retryable` is true only for the config case. Everything else is a proposal
 * the human acts on, which is exactly the "propose, never auto-apply" rule.
 */

/**
 * @param {{classification, explanation, suggestion, safeFix}|null} diagnosis
 * @param {{envVars?: string[]}} requirements
 * @returns {{retryable, kind, requiredEnvVars, requiresApproval, message}}
 */
export function proposeRetry(diagnosis, requirements = {}) {
  const fix = diagnosis?.safeFix ?? null;

  if (!fix) {
    return {
      retryable: false,
      kind: 'none',
      requiredEnvVars: [],
      requiresApproval: false,
      message: diagnosis?.suggestion
        ?? 'No automatic retry is available. Read the build logs for the first error, then redeploy.',
    };
  }

  if (fix.type === 'env-var') {
    // The specific key named in the logs, else the keys the project declares.
    const keys = [...new Set(fix.key ? [fix.key] : (requirements.envVars ?? []))];
    return {
      retryable: keys.length > 0,
      kind: 'set-env',
      requiredEnvVars: keys,
      requiresApproval: true,
      message: keys.length
        ? `Provide ${keys.join(', ')} and redeploy. AGENTIQ will set ${keys.length > 1 ? 'them' : 'it'} on the `
          + 'service and redeploy; your code is not changed.'
        : 'The app needs an environment variable that the logs did not name. Add it and redeploy.',
    };
  }

  // start-command, use-port-env, and anything else behaviour-changing: a CODE
  // fix. Surface the suggestion; do not offer to apply it.
  return {
    retryable: false,
    kind: 'code-change',
    requiredEnvVars: [],
    requiresApproval: true,
    message: diagnosis.suggestion,
  };
}

export default proposeRetry;
