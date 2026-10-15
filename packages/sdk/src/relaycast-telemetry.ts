export interface RelaycastTelemetryOptions {
  originActor?: string;
  agentRelayDistinctId?: string;
  /** Unverified correlation hint; servers must resolve ownership from credentials. */
  agentRelayUserId?: string;
  /**
   * Hashed machine id. Forwarded alongside the distinct id so machine-level
   * cross-tabs survive after login, when the distinct id becomes the user id.
   */
  agentRelayMachineId?: string;
  /** Unverified Cloud organization correlation hint. */
  agentRelayOrgId?: string;
  /** Cloud organization slug, for readable breakdowns. */
  agentRelayOrgSlug?: string;
}

type Env = Record<string, string | undefined>;

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

function defaultEnv(): Env {
  return (globalThis as { process?: { env?: Env } }).process?.env ?? {};
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveOriginActor(env: Env): string | undefined {
  const explicit = nonEmpty(env[ORIGIN_ACTOR_ENV]);
  if (explicit) return explicit;
  const harness = HARNESS_ENV_KEYS.map((key) => nonEmpty(env[key])).find((value): value is string =>
    Boolean(value)
  );
  return harness ? `agent-relay-cli/agent/${harness}` : undefined;
}

/**
 * Identity env vars published by the CLI bootstrap from `cloud-identity.json`
 * (see `@agent-relay/cloud/identity`). Read as plain env here so the SDK stays
 * free of a cloud dependency.
 */
const USER_ID_ENV = 'AGENT_RELAY_USER_ID';
const MACHINE_ID_ENV = 'AGENT_RELAY_MACHINE_ID';
const ORG_ID_ENV = 'AGENT_RELAY_ORG_ID';
const ORG_SLUG_ENV = 'AGENT_RELAY_ORG_SLUG';

export function relaycastTelemetryOptions(
  explicit: RelaycastTelemetryOptions = {},
  env: Env = defaultEnv()
): RelaycastTelemetryOptions {
  if (
    [env.AGENT_RELAY_TELEMETRY_DISABLED, env.DO_NOT_TRACK].some(
      (value) => value === '1' || value?.toLowerCase() === 'true'
    )
  )
    return {};
  // Delegated Cloud credentials do not establish the local operator's identity.
  // The receiving service must resolve their owner from its authenticated context.
  const originActor = nonEmpty(explicit.originActor) ?? resolveOriginActor(env);
  const agentRelayUserId = nonEmpty(explicit.agentRelayUserId) ?? nonEmpty(env[USER_ID_ENV]);
  const agentRelayMachineId = nonEmpty(explicit.agentRelayMachineId) ?? nonEmpty(env[MACHINE_ID_ENV]);
  if (env.CLOUD_API_ACCESS_TOKEN?.trim())
    return {
      ...(originActor ? { originActor } : {}),
      ...(agentRelayMachineId ? { agentRelayMachineId } : {}),
    };
  // Forward the current auth generation as a correlation hint; never use a machine id.
  const agentRelayDistinctId =
    nonEmpty(explicit.agentRelayDistinctId) ?? nonEmpty(env.AGENT_RELAY_DISTINCT_ID) ?? agentRelayUserId;
  const agentRelayOrgId = nonEmpty(explicit.agentRelayOrgId) ?? nonEmpty(env[ORG_ID_ENV]);
  const agentRelayOrgSlug = nonEmpty(explicit.agentRelayOrgSlug) ?? nonEmpty(env[ORG_SLUG_ENV]);

  return {
    ...(originActor ? { originActor } : {}),
    ...(agentRelayDistinctId ? { agentRelayDistinctId } : {}),
    ...(agentRelayUserId ? { agentRelayUserId } : {}),
    ...(agentRelayMachineId ? { agentRelayMachineId } : {}),
    ...(agentRelayOrgId ? { agentRelayOrgId } : {}),
    ...(agentRelayOrgSlug ? { agentRelayOrgSlug } : {}),
  };
}

export function relaycastWorkspaceTelemetryOptions(
  explicit: RelaycastTelemetryOptions = {},
  env: Env = defaultEnv()
): Omit<RelaycastTelemetryOptions, 'originActor'> {
  const { originActor: _originActor, ...identity } = relaycastTelemetryOptions(explicit, env);
  return identity;
}

export function withRelaycastTelemetry<T extends Record<string, unknown>>(
  options: T,
  explicit: RelaycastTelemetryOptions = {},
  env: Env = defaultEnv()
): T & RelaycastTelemetryOptions {
  return { ...options, ...relaycastTelemetryOptions(explicit, env) };
}
