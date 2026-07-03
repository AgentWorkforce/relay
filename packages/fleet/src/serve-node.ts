import fs from 'node:fs';
import path from 'node:path';

import {
  PROTOCOL_VERSION,
  type BrokerToSdk,
  type JsonValue,
  type NodeSupervision,
  type ProtocolEnvelope,
  type SdkToBroker,
} from '@agent-relay/harness-driver/protocol';
import WebSocket, { type RawData } from 'ws';

import {
  invokeNodeHandler,
  nodeInfo,
  nodeManifest,
  triggerSyncInputs,
  type FleetActionContext,
  type FleetNodeDefinition,
  type FleetRelaySendMessageInput,
  type FleetSpawnAgentInput,
} from './index.js';

type SdkFrame<TType extends SdkToBroker['type']> = Extract<SdkToBroker, { type: TType }>;
type SdkPayload<TType extends SdkToBroker['type']> = SdkFrame<TType>['payload'];
type BrokerFrame = ProtocolEnvelope<unknown> & { type: BrokerToSdk['type']; payload: unknown };

/** Client version reported in the broker `hello` handshake. */
const FLEET_CLIENT_VERSION = '8.6.0';

/**
 * Broker connection coordinates for a served fleet node.
 */
export interface FleetBrokerConnection {
  url: string;
  apiKey?: string;
}

/**
 * Diagnostic status snapshot persisted to `statusPath` while a node is served.
 */
export interface FleetSidecarStatus {
  node: string;
  pid: number;
  brokerUrl: string;
  connected: boolean;
  handlers: string[];
  updatedAt: string;
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
  connection: FleetBrokerConnection;
  /**
   * Optional trigger reconciliation client. When provided and the definition
   * declares triggers, the node's triggers are synced on registration.
   */
  triggers?: FleetTriggerSyncClient;
  nameOverride?: string;
  maxAgentsOverride?: number;
  supervision?: NodeSupervision;
  statusPath?: string;
  reconnect?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  onRegistered?: (manifest: ReturnType<typeof nodeManifest>) => void;
}

/**
 * Handle returned by {@link startServeNode} for stopping a running node.
 */
export interface RunningNode {
  stop(): Promise<void>;
  done: Promise<void>;
}

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;

/**
 * Read a persisted fleet node status file.
 * @param statusPath - Path to the JSON status file written by a served node.
 * @returns The parsed status, or `null` when missing or malformed.
 */
export function readFleetSidecarStatus(statusPath: string): FleetSidecarStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as Partial<FleetSidecarStatus>;
    if (
      typeof parsed.node === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.brokerUrl === 'string' &&
      typeof parsed.connected === 'boolean' &&
      Array.isArray(parsed.handlers)
    ) {
      return parsed as FleetSidecarStatus;
    }
  } catch {
    // Missing or malformed status files are treated as no served node.
  }
  return null;
}

/**
 * Start serving a fleet node in the background with reconnect handling.
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
 * Serve a fleet node against a broker, dispatching handler invocations until the
 * abort signal fires. Reconnects with exponential backoff unless disabled.
 * @param options - Node serving options.
 */
export async function serveNode(options: ServeNodeOptions): Promise<void> {
  const reconnect = options.reconnect ?? true;
  let attempt = 0;
  while (!options.signal?.aborted) {
    try {
      await runNodeConnection(options);
      attempt = 0;
      if (!reconnect) {
        return;
      }
    } catch (error) {
      writeStatus(options, false);
      if (!reconnect || options.signal?.aborted) {
        throw error;
      }
      options.warn?.(`Fleet node disconnected: ${errorMessage(error)}; reconnecting`);
    }

    attempt += 1;
    await delay(
      Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1)),
      options.signal
    );
  }
}

/**
 * Build a node supervision descriptor from process argv/cwd/env, filtering the
 * environment to a safe allowlist.
 * @param input - Process argv, working directory, and environment.
 * @returns A supervision descriptor for broker-managed restarts.
 */
export function buildNodeSupervision(input: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): NodeSupervision {
  return {
    argv: [...input.argv],
    cwd: input.cwd,
    env: supervisionEnv(input.env),
  };
}

function runNodeConnection(options: ServeNodeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = fleetWsUrl(options.connection.url);
    const headers: Record<string, string> = {};
    if (options.connection.apiKey) {
      headers['X-API-Key'] = options.connection.apiKey;
    }

    const ws = new WebSocket(url, { headers });
    const pending = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
      }
    >();
    let requestSeq = 0;
    let settled = false;
    let nodeRegistered = false;

    const settle = (fn: typeof resolve | typeof reject, value?: unknown) => {
      if (settled) return;
      settled = true;
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(new Error('fleet node connection closed'));
      }
      pending.clear();
      writeStatus(options, false);
      fn(value as never);
    };

    const sendRequest = <TType extends SdkToBroker['type']>(
      type: TType,
      payload: SdkPayload<TType>
    ): Promise<unknown> => {
      if (ws.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('fleet node websocket is not open'));
      }
      const requestId = `fleet_${Date.now()}_${++requestSeq}`;
      const frame: ProtocolEnvelope<SdkPayload<TType>> = {
        v: PROTOCOL_VERSION,
        type,
        request_id: requestId,
        payload,
      };
      return new Promise((requestResolve, requestReject) => {
        pending.set(requestId, { resolve: requestResolve, reject: requestReject });
        ws.send(JSON.stringify(frame), (error) => {
          if (!error) return;
          pending.delete(requestId);
          requestReject(error);
        });
      });
    };

    const sendHandlerResult = async (invocationId: string, output: unknown, error?: unknown) => {
      const payload: SdkPayload<'handler_result'> = error
        ? { invocation_id: invocationId, error: errorMessage(error) }
        : { invocation_id: invocationId, output: (output ?? null) as JsonValue };
      await sendRequest('handler_result', payload);
    };

    const handleInvoke = async (payload: Extract<BrokerToSdk, { type: 'invoke_handler' }>['payload']) => {
      const ctx = createActionContext(options, sendRequest, payload.invocation_id);
      try {
        const output = await invokeNodeHandler(options.definition, payload.name, payload.input, ctx);
        await sendHandlerResult(payload.invocation_id, output);
      } catch (error) {
        await sendHandlerResult(payload.invocation_id, undefined, error);
      }
    };

    const close = async () => {
      if (ws.readyState === WebSocket.OPEN && nodeRegistered) {
        await sendRequest('deregister_node', {}).catch(() => undefined);
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };

    const abort = () => {
      close().finally(() => settle(resolve));
    };

    options.signal?.addEventListener('abort', abort, { once: true });

    ws.on('open', () => {
      void (async () => {
        const manifest = nodeManifest(options.definition, {
          name: options.nameOverride,
          maxAgents: options.maxAgentsOverride,
        });
        await sendRequest('hello', {
          client_name: '@agent-relay/fleet',
          client_version: FLEET_CLIENT_VERSION,
        });
        await sendRequest('register_node', {
          manifest,
          ...(options.supervision ? { supervision: options.supervision } : {}),
        });
        nodeRegistered = true;
        await sendRequest('register_handlers', {
          names: Object.keys(options.definition.capabilities),
        });
        writeStatus(options, true);
        options.onRegistered?.(manifest);
        await syncTriggers(options);
        options.log?.(
          `Fleet node "${manifest.name}" registered with ${manifest.capabilities.length} capabilities.`
        );
      })().catch((error) => {
        close().finally(() => settle(reject, error));
      });
    });

    ws.on('message', (data) => {
      const frame = parseBrokerFrame(data);
      if (!frame) return;
      if (frame.request_id && pending.has(frame.request_id)) {
        const pendingRequest = pending.get(frame.request_id);
        pending.delete(frame.request_id);
        if (!pendingRequest) return;
        if (frame.type === 'error') {
          pendingRequest.reject(frameError(frame.payload));
        } else {
          pendingRequest.resolve(readOkResult(frame.payload));
        }
        return;
      }
      if (frame.type === 'invoke_handler') {
        void handleInvoke(frame.payload as Extract<BrokerToSdk, { type: 'invoke_handler' }>['payload']).catch(
          (error) => options.warn?.(errorMessage(error))
        );
      }
    });

    ws.on('close', () => {
      options.signal?.removeEventListener('abort', abort);
      settle(resolve);
    });
    ws.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      settle(reject, error);
    });
  });
}

function createActionContext(
  options: ServeNodeOptions,
  sendRequest: <TType extends SdkToBroker['type']>(
    type: TType,
    payload: SdkPayload<TType>
  ) => Promise<unknown>,
  invocationId?: string
): FleetActionContext {
  const info = nodeInfo(options.definition);
  return {
    node: {
      ...info,
      ...(options.nameOverride ? { name: options.nameOverride } : {}),
      ...(options.maxAgentsOverride !== undefined ? { maxAgents: options.maxAgentsOverride } : {}),
    },
    invocationId,
    relay: {
      sendMessage: (input: FleetRelaySendMessageInput) =>
        sendRequest('send_message', {
          to: input.to,
          text: input.text,
          from: input.from ?? options.nameOverride ?? options.definition.name,
          ...(input.threadId ? { thread_id: input.threadId } : {}),
          ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
          ...(input.workspaceAlias ? { workspace_alias: input.workspaceAlias } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.data ? { data: input.data } : {}),
        }),
    },
    spawnAgent: (input: FleetSpawnAgentInput) =>
      sendRequest('spawn_agent', {
        agent: input.agent,
        ...(input.initialTask !== undefined ? { initial_task: input.initialTask } : {}),
        skip_relay_prompt: input.skipRelayPrompt ?? false,
        ...((input.invocationId ?? invocationId)
          ? { invocation_id: input.invocationId ?? invocationId }
          : {}),
      }),
  };
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
    String(trigger.mention ?? ''),
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
    left.channel === right.channel &&
    left.pattern === right.pattern &&
    left.mention === right.mention &&
    left.enabled === right.enabled
  );
}

function parseBrokerFrame(data: RawData): BrokerFrame | null {
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString();
    return JSON.parse(text) as BrokerFrame;
  } catch {
    return null;
  }
}

function readOkResult(payload: unknown): unknown {
  return payload && typeof payload === 'object' && 'result' in payload
    ? (payload as { result?: unknown }).result
    : payload;
}

function frameError(payload: unknown): Error {
  if (payload && typeof payload === 'object') {
    const record = payload as { code?: unknown; message?: unknown };
    const message = typeof record.message === 'string' ? record.message : 'fleet node request failed';
    const error = new Error(message);
    error.name = typeof record.code === 'string' ? record.code : 'FleetNodeError';
    return error;
  }
  return new Error('fleet node request failed');
}

function fleetWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/fleet/ws`;
}

function writeStatus(options: ServeNodeOptions, connected: boolean): void {
  if (!options.statusPath) {
    return;
  }
  const status: FleetSidecarStatus = {
    node: options.nameOverride ?? options.definition.name,
    pid: process.pid,
    brokerUrl: options.connection.url,
    connected,
    handlers: Object.keys(options.definition.capabilities),
    updatedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(options.statusPath), { recursive: true });
    fs.writeFileSync(options.statusPath, JSON.stringify(status, null, 2));
  } catch {
    // Status is diagnostic only.
  }
}

function supervisionEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const keys = [
    'AGENT_RELAY_DATA_DIR',
    'AGENT_RELAY_STATE_DIR',
    'AGENT_RELAY_HOME',
    'RELAY_WORKSPACE_KEY',
    'RELAY_API_KEY',
    'RELAY_BASE_URL',
    'RELAY_NODE_TOKEN',
    'PATH',
    'HOME',
    'SHELL',
  ];
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = env[key];
      return value ? [[key, value]] : [];
    })
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
