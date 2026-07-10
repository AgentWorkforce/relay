import { NodeProviderClient, type NodeCapabilityHandler, type NodeHandlerContext } from '@relaycast/sdk';

import {
  invokeNodeHandler,
  nodeInfo,
  triggerSyncInputs,
  type FleetActionContext,
  type FleetNodeDefinition,
  type FleetRelaySendMessageInput,
  type FleetSpawnAgentInput,
} from './index.js';

/**
 * Engine connection coordinates for a served node. All providers on a node share
 * the node's `nt_live_` token; the served definition attaches as its own provider
 * directly to the engine, alongside the broker provider.
 */
export interface NodeEngineConnection {
  /** Engine base URL (e.g. `https://cast.agentrelay.com`). */
  baseUrl?: string;
  /** The node's shared `nt_live_` token. */
  nodeToken: string;
  /** The enrolled node id this provider attaches to. */
  nodeId: string;
}

/**
 * A single existing trigger as reported by the relay triggers API.
 * Mirrors the relay `RelayTrigger` shape so the CLI adapter is trivial.
 */
export interface FleetTriggerSyncTrigger {
  id?: string;
  channel?: string;
  pattern?: string;
  mention?: boolean | string;
  actionName: string;
  enabled?: boolean;
}

/**
 * Dependency-injected trigger API used to reconcile a node's declared triggers
 * with the workspace. The CLI supplies an adapter backed by `AgentRelay.triggers`
 * so fleet never constructs a relay client (avoids a circular dependency on
 * the relay SDK). When absent, trigger sync is skipped silently.
 */
export interface FleetTriggerSyncClient {
  list(): Promise<FleetTriggerSyncTrigger[]>;
  create(input: {
    channel?: string;
    pattern?: string;
    mention?: boolean | string;
    actionName: string;
    enabled: boolean;
  }): Promise<unknown>;
  update(
    id: string,
    input: {
      channel?: string;
      pattern?: string;
      mention?: boolean | string;
      actionName: string;
      enabled: boolean;
    }
  ): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

/**
 * Options for {@link serveNode} / {@link startServeNode}.
 */
export interface ServeNodeOptions {
  definition: FleetNodeDefinition;
  connection: NodeEngineConnection;
  /**
   * Provider identity name for this served definition, distinct from the broker
   * provider ("broker") on the same node. Defaults to the definition name.
   */
  providerName?: string;
  /**
   * Optional trigger reconciliation client. When provided and the definition
   * declares triggers, the node's triggers are synced on registration.
   */
  triggers?: FleetTriggerSyncClient;
  /** Node name override (the target others address); defaults to the definition name. */
  nameOverride?: string;
  maxAgentsOverride?: number;
  reconnect?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  onRegistered?: (info: ReturnType<typeof nodeInfo>) => void;
}

/**
 * Handle returned by {@link startServeNode} for stopping a running node.
 */
export interface RunningNode {
  stop(): Promise<void>;
  done: Promise<void>;
}

/**
 * Start serving a fleet node in the background. The underlying
 * {@link NodeProviderClient} reconnects with backoff on unexpected drops.
 * @param options - Node serving options.
 * @returns A handle to stop the node and await completion.
 */
export function startServeNode(options: ServeNodeOptions): RunningNode {
  const controller = new AbortController();
  const signal = anySignal([controller.signal, options.signal].filter(Boolean) as AbortSignal[]);
  const done = serveNode({ ...options, signal }).catch((error) => {
    if (!signal.aborted) {
      throw error;
    }
  });
  return {
    stop: async () => {
      controller.abort();
      await done;
    },
    done,
  };
}

/**
 * Serve a fleet node against the engine, dispatching capability invocations until
 * the abort signal fires. Registers the definition's capabilities as a provider
 * on the node and executes their invokes via the handler context helpers.
 * @param options - Node serving options.
 */
export async function serveNode(options: ServeNodeOptions): Promise<void> {
  // An already-aborted signal never fires an 'abort' event, so the stop hook
  // below would not run — return before allocating/connecting the client.
  if (options.signal?.aborted) {
    return;
  }
  const nodeName = options.nameOverride ?? options.definition.name;
  const providerName = options.providerName ?? options.definition.name;
  const maxAgents = options.maxAgentsOverride ?? options.definition.maxAgents;
  const reconnect = options.reconnect ?? true;

  const client = new NodeProviderClient({
    ...(options.connection.baseUrl ? { baseUrl: options.connection.baseUrl } : {}),
    nodeToken: options.connection.nodeToken,
    nodeId: options.connection.nodeId,
    nodeName,
    provider: { name: providerName },
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(options.definition.tags ? { tags: [...options.definition.tags] } : {}),
    ...(options.definition.version ? { version: options.definition.version } : {}),
    // A drop during shutdown is expected; only surface a real error otherwise.
    ...(reconnect ? {} : { maxReconnectAttempts: 0 }),
    onError: (error) => {
      if (!options.signal?.aborted) {
        options.warn?.(`Fleet node error: ${errorMessage(error)}`);
      }
    },
  });

  for (const name of Object.keys(options.definition.capabilities)) {
    // Both `action` and `spawn` definitions materialize as invokable `action`
    // capabilities: a `spawn:<harness>` definition shadows the node's native
    // capacity, delegating through `ctx.spawnAgent`.
    client.capability(name, { kind: 'action' }, adaptHandler(options, name));
  }

  const abort = () => {
    void client.stop();
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  const servePromise = client.serve();
  try {
    await client.whenRegistered();
  } catch (error) {
    options.signal?.removeEventListener('abort', abort);
    if (options.signal?.aborted) {
      return;
    }
    throw error;
  }

  // Report the effective identity the provider registered with, not the raw
  // definition — name/maxAgents overrides change what actually attached.
  options.onRegistered?.({
    ...nodeInfo(options.definition),
    name: nodeName,
    ...(maxAgents !== undefined ? { maxAgents } : {}),
  });
  await syncTriggers(options);
  options.log?.(
    `Fleet node "${nodeName}" registered provider "${providerName}" with ${
      Object.keys(options.definition.capabilities).length
    } capabilities.`
  );

  try {
    await servePromise;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Adapt a fleet capability handler to the engine node-provider handler contract:
 * validate the input against the capability schema (via {@link invokeNodeHandler})
 * and expose the fleet action context built from the engine handler context.
 */
function adaptHandler(options: ServeNodeOptions, name: string): NodeCapabilityHandler {
  return (input, nodeCtx) =>
    invokeNodeHandler(options.definition, name, input, makeContext(options, nodeCtx));
}

// The engine handler context takes wire-JSON shapes; the fleet authoring API
// carries looser `unknown`-valued records. These aliases pin the exact SDK
// parameter types so the boundary coercion is a single explicit cast.
type NodeMessageInput = Parameters<NodeHandlerContext['sendMessage']>[0];
type NodeSpawnInput = Parameters<NodeHandlerContext['spawnAgent']>[0];

function makeContext(options: ServeNodeOptions, nodeCtx: NodeHandlerContext): FleetActionContext {
  const info = nodeInfo(options.definition);
  const fromDefault = options.nameOverride ?? options.definition.name;
  return {
    node: {
      ...info,
      ...(options.nameOverride ? { name: options.nameOverride } : {}),
      ...(options.maxAgentsOverride !== undefined ? { maxAgents: options.maxAgentsOverride } : {}),
    },
    invocationId: nodeCtx.invocationId,
    relay: {
      sendMessage: (message: FleetRelaySendMessageInput) =>
        nodeCtx.sendMessage({
          to: message.to,
          from: message.from ?? fromDefault,
          text: message.text,
          ...(message.mode ? { mode: message.mode } : {}),
          ...(message.data ? { data: message.data as NodeMessageInput['data'] } : {}),
        }),
    },
    spawnAgent: (spawn: FleetSpawnAgentInput) => nodeCtx.spawnAgent(buildSpawnInput(spawn)),
  };
}

/**
 * Shape a fleet spawn request as the engine `node.spawn` input. Spawn fields are
 * flattened to the top level so the engine's capacity placement reads `cli`
 * (the harness) and the broker's spawn executor reads `name`/`cli`/`task`.
 */
function buildSpawnInput(spawn: FleetSpawnAgentInput): NodeSpawnInput {
  const invocationId = spawn.invocationId;
  return {
    ...spawn.agent,
    ...(spawn.initialTask !== undefined ? { task: spawn.initialTask } : {}),
    skip_relay_prompt: spawn.skipRelayPrompt ?? false,
    ...(invocationId ? { invocation_id: invocationId } : {}),
  } as unknown as NodeSpawnInput;
}

async function syncTriggers(options: ServeNodeOptions): Promise<void> {
  const triggers = triggerSyncInputs(options.definition);
  if (triggers.length === 0 || !options.triggers) {
    return;
  }
  const client = options.triggers;
  try {
    const existing = await client.list();
    const existingByKey = new Map<string, FleetTriggerSyncTrigger[]>();
    for (const trigger of existing) {
      const key = triggerSyncKey(trigger);
      const entries = existingByKey.get(key) ?? [];
      entries.push(trigger);
      existingByKey.set(key, entries);
    }

    await Promise.all(
      triggers.map(async (trigger) => {
        const key = triggerSyncKey(trigger);
        const matches = existingByKey.get(key) ?? [];
        if (matches.length === 0) {
          await client.create({
            channel: trigger.channel,
            pattern: trigger.pattern,
            mention: trigger.mention,
            actionName: trigger.actionName,
            enabled: trigger.enabled,
          });
          return;
        }
        existingByKey.delete(key);
        const [primary, ...duplicates] = matches;
        if (primary && !triggerEquals(primary, trigger) && primary.id) {
          await client.update(primary.id, {
            channel: trigger.channel,
            pattern: trigger.pattern,
            mention: trigger.mention,
            actionName: trigger.actionName,
            enabled: trigger.enabled,
          });
        }
        await Promise.all(
          duplicates.filter((duplicate) => duplicate.id).map((duplicate) => client.delete(duplicate.id!))
        );
      })
    );
  } catch (error) {
    options.warn?.(`Fleet trigger sync skipped: ${errorMessage(error)}`);
  }
}

// Key and equality must normalize identically (absent channel/pattern == '',
// absent mention == false) or reconciliation stops being idempotent: a key
// mismatch re-creates an existing trigger, an equality mismatch re-updates an
// unchanged one.
function normalizeTriggerMention(mention: boolean | string | undefined): boolean | string {
  return mention ?? false;
}

function triggerSyncKey(trigger: {
  channel?: string;
  pattern?: string;
  mention?: boolean | string;
  actionName: string;
}): string {
  return [
    trigger.actionName,
    trigger.channel ?? '',
    trigger.pattern ?? '',
    String(normalizeTriggerMention(trigger.mention)),
  ].join('\u001f');
}

function triggerEquals(
  left: {
    channel?: string;
    pattern?: string;
    mention?: boolean | string;
    actionName: string;
    enabled?: boolean;
  },
  right: {
    channel?: string;
    pattern?: string;
    mention?: boolean | string;
    actionName: string;
    enabled: boolean;
  }
): boolean {
  return (
    left.actionName === right.actionName &&
    (left.channel ?? '') === (right.channel ?? '') &&
    (left.pattern ?? '') === (right.pattern ?? '') &&
    normalizeTriggerMention(left.mention) === normalizeTriggerMention(right.mention) &&
    Boolean(left.enabled) === right.enabled
  );
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) {
    return signals[0]!;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
