/**
 * True when a registration failed because the agent name already exists:
 * the SDK's normalised `name_conflict`, or Relaycast's raw
 * `agent_already_exists` (create-only registration, relaycast#349).
 */
export function isAgentNameConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, rawCode } = error as { code?: unknown; rawCode?: unknown };
  return code === 'name_conflict' || code === 'agent_already_exists' || rawCode === 'agent_already_exists';
}
