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
 */
export function replayMessageMetadata(
  metadata?: Record<string, unknown> | null,
  sessionRef: string | undefined = currentReplaySessionRef()
): Record<string, unknown> | null | undefined {
  if (metadata && Object.hasOwn(metadata, 'session_ref')) return metadata;
  const normalized = resolveReplaySessionRef(sessionRef);
  if (!normalized) return metadata;
  return { ...(metadata ?? {}), session_ref: normalized };
}
