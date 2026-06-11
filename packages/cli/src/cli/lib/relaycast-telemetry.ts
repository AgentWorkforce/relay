export interface RelaycastTelemetryOptions {
  originActor?: string;
  agentRelayDistinctId?: string;
}

/**
 * Explicit `origin_actor` path (`{app}/{type}[/{name}]`), set by the broker for
 * each spawned agent (`agent-relay-cli/agent/<harness>`). See
 * cloud/plans/origin-actor.md.
 */
const ORIGIN_ACTOR_ENV = 'AGENT_RELAY_ORIGIN_ACTOR';
/**
 * Fallback: synthesize a path from the orchestrator harness when no explicit
 * origin_actor is set (e.g. a standalone MCP running under a harness).
 */
const HARNESS_ENV_KEYS = [
  'AGENT_RELAY_HARNESS',
  'AGENT_RELAY_ORCHESTRATOR_HARNESS',
  'RELAYCAST_HARNESS',
  'X_RELAYCAST_HARNESS',
] as const;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveOriginActor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = nonEmpty(env[ORIGIN_ACTOR_ENV]);
  if (explicit) return explicit;
  const harness = HARNESS_ENV_KEYS.map((key) => nonEmpty(env[key])).find((value): value is string =>
    Boolean(value)
  );
  return harness ? `agent-relay-cli/agent/${harness}` : undefined;
}

export function relaycastTelemetryOptions(env: NodeJS.ProcessEnv = process.env): RelaycastTelemetryOptions {
  const originActor = resolveOriginActor(env);
  const agentRelayDistinctId = nonEmpty(env.AGENT_RELAY_DISTINCT_ID);

  return {
    ...(originActor ? { originActor } : {}),
    ...(agentRelayDistinctId ? { agentRelayDistinctId } : {}),
  };
}

export function relaycastWorkspaceTelemetryOptions(
  env: NodeJS.ProcessEnv = process.env
): Pick<RelaycastTelemetryOptions, 'agentRelayDistinctId'> {
  const { agentRelayDistinctId } = relaycastTelemetryOptions(env);
  return agentRelayDistinctId ? { agentRelayDistinctId } : {};
}

export function withRelaycastTelemetry<T extends Record<string, unknown>>(
  options: T,
  env: NodeJS.ProcessEnv = process.env
): T & RelaycastTelemetryOptions {
  return { ...options, ...relaycastTelemetryOptions(env) };
}
