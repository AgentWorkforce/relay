export interface RelaycastTelemetryOptions {
  originActor?: string;
  agentRelayDistinctId?: string;
  /** Cloud user id of the signed-in operator, when known. */
  agentRelayUserId?: string;
  /**
   * Hashed machine id. Forwarded alongside the distinct id so machine-level
   * cross-tabs survive after login, when the distinct id becomes the user id.
   */
  agentRelayMachineId?: string;
  /** Cloud organization id, for group analytics on the relaycast side. */
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
  const originActor = nonEmpty(explicit.originActor) ?? resolveOriginActor(env);
  const agentRelayUserId = nonEmpty(explicit.agentRelayUserId) ?? nonEmpty(env[USER_ID_ENV]);
  const agentRelayMachineId =
    nonEmpty(explicit.agentRelayMachineId) ?? nonEmpty(env[MACHINE_ID_ENV]);
  // A signed-in user id is the better person key; the machine hash is fallback.
  const agentRelayDistinctId =
    nonEmpty(explicit.agentRelayDistinctId) ??
    nonEmpty(env.AGENT_RELAY_DISTINCT_ID) ??
    agentRelayUserId ??
    agentRelayMachineId;
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
