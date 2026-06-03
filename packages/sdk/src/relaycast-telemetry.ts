export interface RelaycastTelemetryOptions {
  harness?: string;
  agentRelayDistinctId?: string;
}

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

export function relaycastTelemetryOptions(
  explicit: RelaycastTelemetryOptions = {},
  env: NodeJS.ProcessEnv = process.env
): RelaycastTelemetryOptions {
  const harness =
    nonEmpty(explicit.harness) ??
    HARNESS_ENV_KEYS.map((key) => nonEmpty(env[key])).find((value): value is string => Boolean(value));
  const agentRelayDistinctId =
    nonEmpty(explicit.agentRelayDistinctId) ?? nonEmpty(env.AGENT_RELAY_DISTINCT_ID);

  return {
    ...(harness ? { harness } : {}),
    ...(agentRelayDistinctId ? { agentRelayDistinctId } : {}),
  };
}

export function relaycastWorkspaceTelemetryOptions(
  explicit: RelaycastTelemetryOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Pick<RelaycastTelemetryOptions, 'agentRelayDistinctId'> {
  const { agentRelayDistinctId } = relaycastTelemetryOptions(explicit, env);
  return agentRelayDistinctId ? { agentRelayDistinctId } : {};
}

export function withRelaycastTelemetry<T extends Record<string, unknown>>(
  options: T,
  explicit: RelaycastTelemetryOptions = {},
  env: NodeJS.ProcessEnv = process.env
): T & RelaycastTelemetryOptions {
  return { ...options, ...relaycastTelemetryOptions(explicit, env) };
}
