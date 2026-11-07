/**
 * Relaycast's release request currently has one audit string rather than
 * separate reason/actor fields. Keep both facts in that durable field so an
 * operator can identify why a release happened and which Relay surface asked
 * for it.
 */
export function attributableReleaseReason(
  reason: unknown,
  actor: string | null | undefined,
  fallbackReason: string
): string {
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  const normalizedActor = actor?.trim() || 'unknown Agent Relay operator';
  return `${normalizedReason || fallbackReason} (actor: ${normalizedActor})`;
}
