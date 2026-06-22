import fs from 'node:fs';
import path from 'node:path';

import { AgentRelay } from '@agent-relay/sdk';
import type {
  FleetActionContext,
  FleetNodeDefinition,
  FleetRelaySendMessageInput,
  FleetSpawnAgentInput,
} from '@agent-relay/fleet';
import {
  defineDefaultLocalNode,
  invokeNodeHandler,
  nodeInfo,
  nodeManifest,
  triggerSyncInputs,
} from '@agent-relay/fleet';
import {
  PROTOCOL_VERSION,
  type BrokerToSdk,
  type JsonValue,
  type NodeSupervision,
  type ProtocolEnvelope,
  type SdkToBroker,
} from '@agent-relay/harness-driver/protocol';
import WebSocket, { type RawData } from 'ws';

import type { CoreProjectPaths, CoreTeamsConfig } from '../commands/core.js';

type SdkFrame<TType extends SdkToBroker['type']> = Extract<SdkToBroker, { type: TType }>;
type SdkPayload<TType extends SdkToBroker['type']> = SdkFrame<TType>['payload'];
type BrokerFrame = ProtocolEnvelope<unknown> & { type: BrokerToSdk['type']; payload: unknown };

export interface FleetBrokerConnection {
  url: string;
  apiKey?: string;
}

export interface FleetSidecarStatus {
  node: string;
  pid: number;
  brokerUrl: string;
  connected: boolean;
  handlers: string[];
  updatedAt: string;
}

export interface FleetServeSidecarOptions {
  definition: FleetNodeDefinition;
  connection: FleetBrokerConnection;
  workspaceKey?: string;
  baseUrl?: string;
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

export interface RunningFleetSidecar {
  stop(): Promise<void>;
  done: Promise<void>;
}

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;

export function fleetStatusPath(paths: CoreProjectPaths): string {
  return path.join(paths.dataDir, 'fleet-node.json');
}

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
    // Missing or malformed status files are treated as no sidecar.
  }
  return null;
}

export function createImplicitLocalFleetNode(input: {
  paths: CoreProjectPaths;
  teamsConfig?: CoreTeamsConfig | null;
  name?: string;
  maxAgents?: number;
}): FleetNodeDefinition {
  return defineDefaultLocalNode({
    name: input.name ?? (path.basename(input.paths.projectRoot) || 'local-node'),
    ...(input.maxAgents !== undefined ? { maxAgents: input.maxAgents } : {}),
    teams: input.teamsConfig ?? null,
  });
}

export function startFleetSidecar(options: FleetServeSidecarOptions): RunningFleetSidecar {
  const controller = new AbortController();
  const signal = anySignal([controller.signal, options.signal].filter(Boolean) as AbortSignal[]);
  const done = serveFleetSidecar({ ...options, signal }).catch((error) => {
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

export async function serveFleetSidecar(options: FleetServeSidecarOptions): Promise<void> {
  const reconnect = options.reconnect ?? true;
  let attempt = 0;
  while (!options.signal?.aborted) {
    try {
      await runFleetSidecarConnection(options);
      attempt = 0;
      if (!reconnect) {
        return;
      }
    } catch (error) {
      writeStatus(options, false);
      if (!reconnect || options.signal?.aborted) {
        throw error;
      }
      options.warn?.(`Fleet sidecar disconnected: ${errorMessage(error)}; reconnecting`);
    }

    attempt += 1;
    await delay(
      Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1)),
      options.signal
    );
  }
}

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

function runFleetSidecarConnection(options: FleetServeSidecarOptions): Promise<void> {
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
        pendingRequest.reject(new Error('fleet sidecar connection closed'));
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
        return Promise.reject(new Error('fleet sidecar websocket is not open'));
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
          client_version: '8.6.0',
        });
        await sendRequest('register_node', {
          manifest,
          ...(options.supervision ? { supervision: options.supervision } : {}),
        });
        nodeRegistered = true;
        await sendRequest('register_handlers', { names: Object.keys(options.definition.capabilities) });
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
  options: FleetServeSidecarOptions,
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

async function syncTriggers(options: FleetServeSidecarOptions): Promise<void> {
  const triggers = triggerSyncInputs(options.definition);
  if (triggers.length === 0 || !options.workspaceKey) {
    return;
  }
  try {
    const relay = new AgentRelay({ workspaceKey: options.workspaceKey, baseUrl: options.baseUrl });
    const existing = await relay.triggers.list();
    const existingByKey = new Map<string, typeof existing>();
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
          await relay.triggers.create({
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
        if (!triggerEquals(primary, trigger) && primary.id) {
          await relay.triggers.update(primary.id, {
            channel: trigger.channel,
            pattern: trigger.pattern,
            mention: trigger.mention,
            actionName: trigger.actionName,
            enabled: trigger.enabled,
          });
        }
        await Promise.all(
          duplicates
            .filter((duplicate) => duplicate.id)
            .map((duplicate) => relay.triggers.delete(duplicate.id!))
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
    const message = typeof record.message === 'string' ? record.message : 'fleet sidecar request failed';
    const error = new Error(message);
    error.name = typeof record.code === 'string' ? record.code : 'FleetSidecarError';
    return error;
  }
  return new Error('fleet sidecar request failed');
}

function fleetWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/fleet/ws`;
}

function writeStatus(options: FleetServeSidecarOptions, connected: boolean): void {
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
