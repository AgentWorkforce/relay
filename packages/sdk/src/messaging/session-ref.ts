export const RELAY_ATTEST_SESSION_ID_ENV = 'RELAY_ATTEST_SESSION_ID';
const MAX_SESSION_REF_LENGTH = 255;

/** Normalize the stable replay key carried by a spawned Relay session. */
export function resolveReplaySessionRef(value?: string): string | undefined {
  const sessionRef = value?.trim();
  if (!sessionRef || Array.from(sessionRef).length > MAX_SESSION_REF_LENGTH) return undefined;
  return sessionRef;
}

/** Resolve the current process's replay key without assuming a Node-only runtime. */
export function currentReplaySessionRef(): string | undefined {
  return resolveReplaySessionRef(
    typeof process === 'undefined' ? undefined : process.env[RELAY_ATTEST_SESSION_ID_ENV]
  );
}

/**
 * Add the stable replay key unless the caller deliberately supplied one.
 * Relaycast validates explicit values; this helper only suppresses unusable
 * inherited environment values so they cannot break unrelated message sends.
 *
 * Call arity is load-bearing: with no second argument the current process's
 * `RELAY_ATTEST_SESSION_ID` is used. Passing `sessionRef` explicitly — even as
 * `undefined` — opts out of that fallback, so a caller that supplied an
 * unusable ref cannot silently be re-attributed to the ambient environment
 * session.
 */
export function replayMessageMetadata(
  metadata?: Record<string, unknown> | null
): Record<string, unknown> | null | undefined;
export function replayMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
  sessionRef: string | undefined
): Record<string, unknown> | null | undefined;
export function replayMessageMetadata(
  metadata?: Record<string, unknown> | null,
  ...rest: [] | [string | undefined]
): Record<string, unknown> | null | undefined {
  if (metadata && Object.hasOwn(metadata, 'session_ref')) return metadata;
  const sessionRef: string | undefined = rest.length === 0 ? currentReplaySessionRef() : rest[0];
  const normalized = resolveReplaySessionRef(sessionRef);
  if (!normalized) return metadata;
  return { ...(metadata ?? {}), session_ref: normalized };
}
