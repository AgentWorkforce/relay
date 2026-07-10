/**
 * Structural secret redaction for anything that gets printed or logged.
 *
 * The broker session carries the node token and workspace key; command output
 * (e.g. `fleet status`) and any future debug dump must never surface them. Run
 * the value through {@link redactSecrets} at the serialization boundary so the
 * redaction is a property of the display path, not a promise that a given field
 * "isn't printed today".
 */

/** Keys whose values are credentials and must be redacted before display. */
const SECRET_KEY = /token|secret|password|api[_-]?key|workspace[_-]?key|authorization/i;

const REDACTED = '[redacted]';

/**
 * Deep-copy `value`, replacing the value of any credential-named key with
 * `[redacted]`. Non-secret keys are preserved and recursed into.
 */
export function redactSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) =>
        SECRET_KEY.test(key) ? [key, child == null ? child : REDACTED] : [key, redactSecrets(child)]
      )
    ) as T;
  }
  return value;
}
