export const DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS = 15_000;

// setTimeout coerces its delay with ToNumber and silently clamps non-finite,
// negative, or >2^31-1 values to ~1ms (or fires on the next tick), so a bad
// caller-supplied timeoutMs must not reach it directly — it would turn
// "bounded registration" into "registration always times out immediately".
const MAX_SETTIMEOUT_DELAY_MS = 2_147_483_647;

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, MAX_SETTIMEOUT_DELAY_MS);
}

// Single-quote the name for safe inclusion in a copy-pasteable shell command:
// close the quote, emit an escaped literal quote, reopen. Without this, a
// name containing `$(...)` or backticks would execute command substitution
// if a user copies the recovery command as-is into a shell.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bound an arbitrary async operation so a hung upstream call cannot hang the
 * caller forever. `buildTimeoutError` receives the normalized timeout so
 * callers can render an accurate message.
 */
export async function withDeadline<T>(
  operation: () => Promise<T>,
  buildTimeoutError: (effectiveTimeoutMs: number) => Error,
  timeoutMs = DEFAULT_AGENT_REGISTRATION_TIMEOUT_MS
): Promise<T> {
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(buildTimeoutError(effectiveTimeoutMs)), effectiveTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  return withDeadline(
    register,
    (effectiveTimeoutMs) => {
      const renderedName = shellQuote(name);
      return new Error(
        `Agent registration or token rotation for ${JSON.stringify(name)} did not complete within ${effectiveTimeoutMs}ms. ` +
          'The request outcome is unknown. Retry with ' +
          `\`agent-relay agent rotate ${renderedName}\`; if rotation continues to time out, run ` +
          `\`agent-relay agent remove ${renderedName} --reason "recover stale token"\` and then register again.`
      );
    },
    timeoutMs
  );
}
