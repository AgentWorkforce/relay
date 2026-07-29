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

/** Known live-credential prefixes, kept visible so a masked value still identifies its kind. */
const SECRET_PREFIX = /^(rk_live_|at_live_|nt_live_|ot_live_|br_|rth_at_|ocl_node_enr_)/;

/**
 * Mask a credential for display: the known prefix (if any) and the last four
 * characters stay visible, everything else collapses to `…`. Values too short
 * to safely show a suffix mask entirely. Use this wherever a command prints a
 * key on purpose — the masked form still identifies which credential it is
 * without being usable.
 */
export function maskSecret(value: string): string {
  const prefix = value.match(SECRET_PREFIX)?.[1] ?? '';
  const body = value.slice(prefix.length);
  if (body.length <= 8) {
    return `${prefix}…`;
  }
  return `${prefix}…${body.slice(-4)}`;
}

const REDACTED = '[redacted]';

const CIRCULAR = '[circular]';

/**
 * Deep-copy `value`, replacing the value of any credential-named key with
 * `[redacted]`. Non-secret keys are preserved and recursed into. A value that
 * references one of its own ancestors is emitted as `[circular]` so a cyclic
 * debug dump redacts instead of overflowing the stack.
 */
export function redactSecrets<T>(value: T): T {
  return redact(value, new WeakSet<object>());
}

function redact<T>(value: T, ancestors: WeakSet<object>): T {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const node = value as object;
  if (ancestors.has(node)) {
    return CIRCULAR as unknown as T;
  }
  ancestors.add(node);
  const result = Array.isArray(value)
    ? (value.map((item) => redact(item, ancestors)) as unknown as T)
    : (Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) =>
          SECRET_KEY.test(key) ? [key, child == null ? child : REDACTED] : [key, redact(child, ancestors)]
        )
      ) as T);
  ancestors.delete(node);
  return result;
}
