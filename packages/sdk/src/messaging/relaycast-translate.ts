/**
 * Pure translation helpers between the relaycast wire shapes and relay's
 * domain types. Everything in this module is stateless: it reads loosely-typed
 * records (`unknown`) coming off the relaycast SDK and produces relay-facing
 * objects, or shapes relay inputs into relaycast request payloads.
 *
 * Keeping these free functions out of `RelaycastMessagingClient` lets the
 * stateful client focus on transport/lifecycle while the wire mapping stays
 * independently testable.
 */
import type {
  RelayActionInvocation,
  RelayActionInvocationAck,
  RelayCapability,
  RelayCompleteInvocationInput,
  RelayInboundWebhook,
  RelayMessageAttachmentInput,
  RelayMessageListOptions,
  RelayNode,
  RelayNodeCapability,
  RelayRegisterCapabilityInput,
  RelayTrigger,
  RelayTriggerInput,
  RelayWebhookSubscription,
  RelayWorkspaceFleetNodesConfig,
} from './types.js';

// --- primitive record readers -------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readStr(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function readRecord(
  record: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

export function readNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

export function readBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

export function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

export function readMention(value: unknown): boolean | string | undefined {
  return typeof value === 'boolean' || typeof value === 'string' ? value : undefined;
}

// --- relay input -> relaycast request shapes ---------------------------------

/**
 * Translate a relay capability registration into a relaycast `actions.register`
 * request. Relaycast 2.x replaced the `commands` registry with `actions`:
 * `command` → `name`, `parameters` → `inputSchema`.
 */
export function toRegisterActionRequest(input: RelayRegisterCapabilityInput): Record<string, unknown> {
  // `inputSchema` (a converted JSON Schema) takes precedence over the legacy
  // `parameters` field when both are present.
  const inputSchema = input.inputSchema ?? input.parameters;
  return {
    name: input.command,
    description: input.description,
    handlerAgent: input.handlerAgent,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.availableTo === undefined ? {} : { availableTo: input.availableTo }),
  };
}

export function toTriggerRequest(
  input: RelayTriggerInput | Partial<RelayTriggerInput>
): Record<string, unknown> {
  return {
    ...(input.channel !== undefined ? { channel: input.channel } : {}),
    ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
    ...(input.mention !== undefined ? { mention: input.mention } : {}),
    ...(input.actionName !== undefined
      ? { actionName: input.actionName, action_name: input.actionName }
      : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  };
}

/** Translate a relay completion result into the relaycast `CompleteInvocationRequest` shape. */
export function toCompleteInvocationRequest(data: RelayCompleteInvocationInput): Record<string, unknown> {
  return {
    ...(data.output === undefined ? {} : { output: data.output }),
    ...(data.error === undefined ? {} : { error: data.error }),
    ...(data.durationMs === undefined ? {} : { durationMs: data.durationMs }),
  };
}

// --- relaycast wire -> relay domain types ------------------------------------

/**
 * Translate a relaycast `ActionDefinition` back into a relay `RelayCapability`,
 * preserving the relay-facing `command`/`parameters` vocabulary.
 */
export function toRelayCapability(raw: unknown): RelayCapability {
  const action = (raw ?? {}) as Record<string, unknown>;
  const command = (action.name ?? action.command) as string;
  return {
    ...action,
    command,
    description: action.description as string | undefined,
    handlerAgent: action.handlerAgent as string | undefined,
    parameters: action.inputSchema ?? action.parameters,
  };
}

export function toRelayNode(raw: unknown): RelayNode {
  const node = (raw ?? {}) as Record<string, unknown>;
  const rawStatus = readStr(node, 'status');
  return {
    id: readStr(node, 'id', 'node_id'),
    nodeId: readStr(node, 'nodeId', 'node_id'),
    name: readStr(node, 'name') ?? '',
    status: rawStatus === 'online' || rawStatus === 'offline' ? rawStatus : 'unknown',
    live: readBoolean(node, 'live'),
    capabilities: Array.isArray(node.capabilities) ? node.capabilities.map(toRelayNodeCapability) : [],
    repoKeys: readRepoKeys(node),
    maxAgents: readNumber(node, 'maxAgents', 'max_agents'),
    activeAgents: readNumber(node, 'activeAgents', 'active_agents'),
    handlersLive: readBoolean(node, 'handlersLive', 'handlers_live'),
    load: readNumber(node, 'load'),
    lastHeartbeatAt: readStr(node, 'lastHeartbeatAt', 'last_heartbeat_at'),
    createdAt: readStr(node, 'createdAt', 'created_at'),
    tags: readStringArray(node, 'tags'),
    version: readStr(node, 'version'),
  };
}

function readRepoKeys(node: Record<string, unknown>): string[] | undefined {
  const direct = readStringArray(node, 'repoKeys') ?? readStringArray(node, 'repo_keys');
  if (direct) return direct;
  const repoPaths = readRecord(node, 'repoPaths', 'repo_paths');
  return repoPaths ? Object.keys(repoPaths).filter(Boolean) : undefined;
}

export function toRelayNodeCapability(raw: unknown): RelayNodeCapability {
  const capability = (raw ?? {}) as Record<string, unknown>;
  return {
    name: readStr(capability, 'name') ?? '',
    kind: readStr(capability, 'kind'),
    metadata: readRecord(capability, 'metadata'),
  };
}

export function toRelayTrigger(raw: unknown): RelayTrigger {
  const trigger = (raw ?? {}) as Record<string, unknown>;
  return {
    id: readStr(trigger, 'id'),
    channel: readStr(trigger, 'channel'),
    pattern: readStr(trigger, 'pattern', 'match'),
    mention: readMention(trigger.mention),
    actionName: readStr(trigger, 'actionName', 'action_name') ?? '',
    enabled: readBoolean(trigger, 'enabled') ?? true,
  };
}

export function toRelayWorkspaceFleetNodesConfig(raw: unknown): RelayWorkspaceFleetNodesConfig {
  const record = asRecord(raw);
  return {
    enabled: readBoolean(record, 'enabled') ?? false,
    defaultEnabled: readBoolean(record, 'defaultEnabled', 'default_enabled') ?? false,
    override: readBoolean(record, 'override') ?? null,
  };
}

/** Normalize a relaycast invoke ack (camelized) into the relay `RelayActionInvocationAck`. */
export function normalizeActionInvocationAck(raw: unknown): RelayActionInvocationAck {
  const record = asRecord(raw);
  return {
    invocationId: readStr(record, 'invocationId', 'invocation_id') ?? '',
    actionName: readStr(record, 'actionName', 'action_name') ?? '',
    ...(readStr(record, 'handlerAgentId', 'handler_agent_id')
      ? { handlerAgentId: readStr(record, 'handlerAgentId', 'handler_agent_id') }
      : {}),
    ...(readStr(record, 'handlerNodeId', 'handler_node_id')
      ? { handlerNodeId: readStr(record, 'handlerNodeId', 'handler_node_id') }
      : {}),
    ...(readStr(record, 'dispatchedNodeId', 'dispatched_node_id')
      ? { dispatchedNodeId: readStr(record, 'dispatchedNodeId', 'dispatched_node_id') }
      : {}),
    ...(readRecord(record, 'input') ? { input: readRecord(record, 'input') } : {}),
    ...(readStr(record, 'status') ? { status: readStr(record, 'status') } : {}),
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
  };
}

/** Normalize a relaycast invocation record (camelized) into `RelayActionInvocation`. */
export function normalizeActionInvocation(raw: unknown): RelayActionInvocation {
  const record = asRecord(raw);
  return {
    invocationId: readStr(record, 'invocationId', 'invocation_id') ?? '',
    actionName: readStr(record, 'actionName', 'action_name') ?? '',
    callerId: (readStr(record, 'callerId', 'caller_id') ?? null) as string | null,
    callerName: (readStr(record, 'callerName', 'caller_name') ?? null) as string | null,
    input: readRecord(record, 'input') ?? {},
    output: readRecord(record, 'output') ?? null,
    status: readStr(record, 'status') ?? 'invoked',
    error: (readStr(record, 'error') ?? null) as string | null,
    durationMs:
      typeof record.durationMs === 'number'
        ? record.durationMs
        : typeof record.duration_ms === 'number'
          ? (record.duration_ms as number)
          : null,
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
    completedAt: (readStr(record, 'completedAt', 'completed_at') ?? null) as string | null,
  };
}

/** Normalize a relaycast inbound webhook (snake_case) into `RelayInboundWebhook`. */
export function normalizeInboundWebhook(raw: unknown): RelayInboundWebhook {
  const record = asRecord(raw);
  return {
    webhookId: readStr(record, 'webhookId', 'webhook_id', 'id') ?? '',
    url: readStr(record, 'url') ?? '',
    token: readStr(record, 'token') ?? '',
    channel: readStr(record, 'channel') ?? '',
    ...(readStr(record, 'name') ? { name: readStr(record, 'name') } : {}),
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
  };
}

/** Normalize a relaycast event subscription into `RelayWebhookSubscription`. */
export function normalizeWebhookSubscription(raw: unknown): RelayWebhookSubscription {
  const record = asRecord(raw);
  const events = Array.isArray(record.events)
    ? record.events.filter((event): event is string => typeof event === 'string')
    : undefined;
  return {
    id: readStr(record, 'id') ?? '',
    ...(readStr(record, 'url') ? { url: readStr(record, 'url') } : {}),
    ...(events ? { events } : {}),
    ...(readStr(record, 'createdAt', 'created_at')
      ? { createdAt: readStr(record, 'createdAt', 'created_at') }
      : {}),
  };
}

// --- option shaping ----------------------------------------------------------

export function definedOptions<T extends Record<string, unknown>>(options: T): Partial<T> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function toMessageListOptions(
  options?: RelayMessageListOptions
): RelayMessageListOptions | undefined {
  if (!options) return undefined;
  return definedOptions({
    limit: options.limit,
    before: options.before,
    after: options.after,
  });
}

export function serializeAttachmentInputs(input?: RelayMessageAttachmentInput[]): string[] | undefined {
  if (!input) return undefined;
  return input.map((attachment) =>
    typeof attachment === 'string' ? attachment : JSON.stringify(attachment)
  );
}
