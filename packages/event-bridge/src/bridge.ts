import path from 'node:path';

import {
  events,
  type EventStreamHandle,
  type RelayfileChangeEvent,
  type WatchRegistration,
} from '@agent-relay/events';
import { AgentRelayClient } from '@agent-relay/sdk/client';

import type { EventBridgeConfig } from './config.js';
import { createProvider } from './providers/index.js';
import { startOutboxWatcher } from './outbox.js';
import type { ProviderAdapter, WorkspaceFileLike } from './types.js';

/** Minimal broker surface the bridge needs to inject inbound messages. */
export interface BrokerLike {
  sendMessage(input: {
    to: string;
    text: string;
    from?: string;
    threadId?: string;
    mode?: 'wait' | 'steer';
  }): Promise<unknown>;
}

/** Structured log sink. */
export type BridgeLogger = (message: string, fields?: Record<string, unknown>) => void;

/**
 * Injectable dependencies, primarily for testing.
 */
export interface EventBridgeDeps {
  /** Override the gateway stream factory. */
  createStream?: typeof events;
  /** Override the broker client (defaults to a remote/local {@link AgentRelayClient}). */
  broker?: BrokerLike;
  /** Override the provider adapters (defaults to constructing from config). */
  providers?: ProviderAdapter[];
  /** Override the outbox watcher factory. */
  startOutbox?: typeof startOutboxWatcher;
  /** Log sink. Defaults to no-op. */
  logger?: BridgeLogger;
}

/**
 * Handle returned by {@link createEventBridge}.
 */
export interface EventBridgeHandle {
  /** Resolves once the gateway is subscribed and the outbox watcher is live. */
  ready: Promise<void>;
  /** Tear down the stream and outbox watcher. */
  stop: () => Promise<void>;
}

/** A reply the bridge is awaiting from the agent's outbox. */
interface PendingReply {
  source: string;
  replyPath: string;
  serializeReply: (replyText: string) => { content: string; contentType: string };
}

const MAX_DEDUP = 2000;

/**
 * Wire a long-lived on-relay agent to inbound integration webhook events.
 *
 * Inbound: subscribes to the gateway, and for each actionable provider change
 * injects a nudge into the target agent telling it where to write its reply.
 * Outbound: watches the agent's outbox dir and relays each reply file through
 * the gateway as a relayfile write, which the provider's writeback posts back
 * to the source (e.g. Slack). The agent itself needs no mount, MCP, or creds —
 * just its native file-write tool.
 */
export function createEventBridge(config: EventBridgeConfig, deps: EventBridgeDeps = {}): EventBridgeHandle {
  const log: BridgeLogger = deps.logger ?? (() => {});
  const providers = deps.providers ?? config.providers.map(createProvider);
  const providersByName = new Map(providers.map((provider) => [provider.name, provider]));
  const broker = deps.broker ?? resolveBroker(config);

  const pending = new Map<string, PendingReply>();
  const handled = new Set<string>();
  const stopController = new AbortController();

  const handleEvent = async (event: { type: string }): Promise<void> => {
    if (event.type !== 'relayfile.changed') {
      return;
    }
    const change = event as RelayfileChangeEvent;
    if (handled.has(change.id)) {
      return;
    }
    remember(handled, change.id);

    const provider = providersByName.get(change.resource.provider) ?? matchByPath(providers, change.path);
    if (!provider) {
      return;
    }

    const file = await readFileSafe(stream, change.path);
    const replyId = mintReplyId();
    const item = provider.resolveInbound(change, file, { replyId });
    if (!item) {
      return;
    }

    pending.set(replyId, {
      source: item.source,
      replyPath: item.replyPath,
      serializeReply: item.serializeReply,
    });

    const outboxFile = path.join(config.outboxDir, `${replyId}.md`);
    const text = `${item.body}\n\n↩️ To reply, write your response as plain text to:\n  ${outboxFile}\nWhatever you write there is posted back to ${item.source}. Leave it empty / write nothing to stay silent.`;

    try {
      await broker.sendMessage({
        to: config.agentName,
        from: `${provider.name}:${item.source}`,
        text,
        mode: config.injectMode,
      });
      log('injected inbound', {
        provider: provider.name,
        source: item.source,
        replyId,
        agent: config.agentName,
      });
    } catch (err) {
      pending.delete(replyId);
      log('inject failed', { provider: provider.name, replyId, error: errMessage(err) });
    }
  };

  const stream: EventStreamHandle = (deps.createStream ?? events)({
    workspace: config.workspace,
    apiKey: config.apiKey,
    agentId: `event-bridge:${config.agentName}`,
    ...(config.gatewayUrl ? { gatewayUrl: config.gatewayUrl } : {}),
    signal: stopController.signal,
    onEvent: handleEvent,
    onError: async (error) => {
      log('stream error', { error: errMessage(error) });
    },
  });

  const onReply = async (replyId: string, replyText: string): Promise<void> => {
    const target = pending.get(replyId);
    if (!target) {
      return;
    }
    const trimmed = replyText.trim();
    if (!trimmed) {
      // Empty reply file = stay silent. Consume the pending entry.
      pending.delete(replyId);
      log('reply skipped (empty)', { replyId, source: target.source });
      return;
    }
    const { content, contentType } = target.serializeReply(trimmed);
    try {
      await stream.writeFile(target.replyPath, content, { contentType });
      pending.delete(replyId);
      log('reply posted', { replyId, source: target.source, path: target.replyPath });
    } catch (err) {
      log('reply writeback failed', { replyId, source: target.source, error: errMessage(err) });
    }
  };

  const startOutbox = deps.startOutbox ?? startOutboxWatcher;
  let outboxHandle: Awaited<ReturnType<typeof startOutboxWatcher>> | null = null;

  const ready = (async () => {
    await stream.ready;
    const watches = buildWatches(providers, config.replayOnStart);
    if (watches.length > 0) {
      await stream.registerWatches(watches);
    }
    outboxHandle = await startOutbox({
      dir: config.outboxDir,
      isPending: (replyId) => pending.has(replyId),
      onReply,
      onError: (err) => log('outbox error', { error: err.message }),
    });
    log('ready', {
      workspace: config.workspace,
      agent: config.agentName,
      providers: providers.map((provider) => provider.name),
      outbox: config.outboxDir,
    });
  })();

  return {
    ready,
    stop: async () => {
      stopController.abort(new Error('event bridge stopping'));
      await stream.close().catch(() => {});
      await outboxHandle?.stop().catch(() => {});
    },
  };
}

function resolveBroker(config: EventBridgeConfig): BrokerLike {
  if (config.brokerUrl) {
    return new AgentRelayClient({ baseUrl: config.brokerUrl, apiKey: config.apiKey });
  }
  return AgentRelayClient.connect({ cwd: config.brokerCwd ?? process.cwd() });
}

function buildWatches(providers: ProviderAdapter[], replayOnStart?: string): WatchRegistration[] {
  const seen = new Set<string>();
  const watches: WatchRegistration[] = [];
  for (const provider of providers) {
    for (const glob of provider.watch) {
      if (seen.has(glob)) {
        continue;
      }
      seen.add(glob);
      watches.push({
        glob,
        ...(replayOnStart ? { replayOnStart: replayOnStart as WatchRegistration['replayOnStart'] } : {}),
        coalesceMs: 200,
      });
    }
  }
  return watches;
}

/** Fallback provider lookup by path prefix when the event provider is absent. */
function matchByPath(providers: ProviderAdapter[], filePath: string): ProviderAdapter | undefined {
  return providers.find((provider) => filePath.startsWith(`/${provider.name}/`));
}

async function readFileSafe(stream: EventStreamHandle, filePath: string): Promise<WorkspaceFileLike | null> {
  try {
    const raw = await stream.readFile(filePath);
    return normalizeFile(raw, filePath);
  } catch {
    return null;
  }
}

/** Normalize a gateway read response into `{ path, body }`, JSON-decoding when possible. */
function normalizeFile(raw: unknown, filePath: string): WorkspaceFileLike {
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if ('body' in record) {
      return { path: filePath, body: record.body };
    }
    const content = record.content;
    if (typeof content === 'string') {
      return { path: filePath, body: tryJson(content) };
    }
    return { path: filePath, body: raw };
  }
  if (typeof raw === 'string') {
    return { path: filePath, body: tryJson(raw) };
  }
  return { path: filePath, body: raw };
}

function tryJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function mintReplyId(): string {
  return `r-${globalThis.crypto.randomUUID().slice(0, 8)}`;
}

/** Track an id in a bounded set so dedup memory stays flat. */
function remember(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > MAX_DEDUP) {
    const first = set.values().next().value;
    if (first !== undefined) {
      set.delete(first);
    }
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
