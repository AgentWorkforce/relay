export const DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS = 15_000;

/**
 * Bound identity registration/rotation so an existing broken record cannot
 * hang an MCP or CLI caller forever.
 *
 * The upstream request may have reached the service before the local deadline,
 * so the error is explicit that the outcome is unknown and points at the
 * supported rotation and remove/re-register recovery paths.
 */
export async function withAgentRegistrationDeadline<T>(
  register: () => Promise<T>,
  name: string,
  timeoutMs = DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      register(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const renderedName = JSON.stringify(name);
          reject(
            new Error(
              `Agent registration or token rotation for ${renderedName} did not complete within ${timeoutMs}ms. ` +
                'The request outcome is unknown. Retry with ' +
                `\`agent-relay agent rotate ${renderedName}\`; if rotation continues to time out, run ` +
                `\`agent-relay agent remove ${renderedName} --reason "recover stale token"\` and then register again.`
            )
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
