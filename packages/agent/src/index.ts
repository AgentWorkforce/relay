import {
  createLogger,
  createStartupEvent,
  events,
  NoRetry,
  relayfileTools,
  type AgentEvent,
  type CronTickEvent,
  type EventType,
  type Expansion,
  type ExpansionLevel,
  type StructuredLogEntry,
  type RelaycastMessageEvent,
  type RelayfileChangeEvent,
  type StartupEvent,
  type WatchRegistration,
} from '@agent-relay/events';
import { RelayFileClient as RelayFileSdkClient } from '@relayfile/sdk';

import { createContextFactory } from './context.js';
import { deployAgent } from './deploy.js';
import { createDispatcher } from './dispatcher.js';
import type {
  AgentDefinition,
  FileSummary,
  AgentHandle,
  AgentOptions,
  AgentPolicy,
  AgentPolicyMode,
  AgentProviderConfig,
  ApprovalVerdictRecord,
  CoalesceMissedTicksMode,
  Context,
  RelaycronClient,
  RelaycronScheduleDefinition,
  RelaycronScheduleHandle,
  RelaycastClient,
  RelayfileClient,
  LogFields,
  Logger,
  PolicyActionType,
  PolicyDecision,
  PolicySuggestion,
  PostOpts,
  ReplayOnStart,
  ScheduleSpec,
  WorkspaceFile,
  WriteMeta,
} from './types.js';

const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 300_000;
const DEFAULT_RELAYFILE_URL = 'https://api.relayfile.dev';
const DEFAULT_RELAYCAST_URL = 'https://api.relaycast.dev';

/**
 * Registers and runs a proactive agent using the layered runtime SDK.
 */
export function agent(definition: AgentDefinition): AgentHandle {
  assertDefinition(definition);

  const options = definition.options ?? {};
  const apiKey = resolveApiKey(options);
  const agentId = sanitizeAgentId(definition.name ?? definition.workspace);
  const scheduleIds = new Set<string>();
  const stopController = new AbortController();
  let relayfileClient: RelayfileClient | null = null;
  let relaycastClient: RelaycastClient | null = null;
  let relaycronClient: RelaycronClient | null = null;
  let onceCoordinator: {
    acquireOnce(key: string): Promise<boolean>;
    releaseOnce(key: string): Promise<void>;
  } | null = null;
  let publishStructuredLog: ((entry: StructuredLogEntry) => void) | null = null;

  const logger = createLogger({
    workspace: definition.workspace,
    agentId,
    level: options.logLevel,
    sink: (entry) => {
      publishStructuredLog?.(entry);
    },
  });

  const contextFactory = createContextFactory({
    workspace: definition.workspace,
    agentId,
    logger,
    getRelayfileClient: () => relayfileClient,
    getRelaycastClient: () => relaycastClient,
    getRelaycronClient: () => relaycronClient,
    getOnceCoordinator: () => onceCoordinator,
    awaitApproval: (approvalId) => stream.awaitApproval(approvalId),
    policy: definition.policy,
    trackSchedule(id) {
      scheduleIds.add(id);
    },
  });

  const dispatcher = createDispatcher({
    concurrency: options.concurrency ?? 1,
    handlerTimeoutMs: options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
    createContext(signal, event) {
      return contextFactory.withEvent(signal, event);
    },
    onEvent(ctx, event) {
      return definition.onEvent(ctx, event);
    },
  });

  const stream = events({
    workspace: definition.workspace,
    apiKey,
    agentId,
    gatewayUrl: options.gatewayUrl,
    signal: stopController.signal,
    onEvent: async (event) => {
      await dispatcher.dispatch(event);
    },
    onError: async (error, event) => {
      const normalized = normalizeError(error);
      contextFactory.base.logger.error('agent event delivery failed', {
        eventId: event.id,
        eventType: event.type,
        error: normalized.message,
      });
      await definition.onError?.(contextFactory.base, normalized, event);
    },
  });
  publishStructuredLog = (entry) => {
    stream.publishLog(entry);
  };
  relayfileClient = shouldUseGatewayTransport(options)
    ? createGatewayRelayfileClient(stream)
    : createDirectRelayfileClient(definition.workspace, apiKey, options);
  relaycastClient = shouldUseGatewayTransport(options)
    ? createGatewayRelaycastClient(stream)
    : createDirectRelaycastClient(apiKey, options);
  relaycronClient = createGatewayRelaycronClient(stream);
  onceCoordinator = createGatewayOnceCoordinator(stream);

  let stopping: Promise<void> | null = null;
  const detachSignals = installSignalHandlers(options, async () => {
    await handle.stop();
  });

  const ready = (async () => {
    await stream.ready;
    await registerSchedules(contextFactory.base, definition.schedule);
    if (shouldUseGatewayTransport(options)) {
      await registerWatches(stream, definition.watch, options);
      await registerInboxes(stream, definition.inbox);
    }
    await definition.onStart?.(contextFactory.base);
    if (shouldEmitLocalStartup(options)) {
      try {
        await stream.trigger(
          createStartupEvent({
            workspace: definition.workspace,
            reason: 'cold-start',
          })
        );
      } catch {
        // The stream-level onError path already surfaced the startup failure.
      }
    }
  })();

  const handle: AgentHandle = {
    ready,
    stop: async () => {
      if (stopping) {
        return stopping;
      }

      stopping = (async () => {
        detachSignals();
        await cancelSchedules(contextFactory.base, scheduleIds);
        dispatcher.close();
        stopController.abort(new Error('Agent stopping'));
        dispatcher.abortActive(new Error('Agent stopping'));
        await stream.close();

        const drained = await dispatcher.drain(options.drainMs ?? DEFAULT_DRAIN_MS);
        if (!drained) {
          await dispatcher.drain(1_000);
        }

        await definition.onStop?.(contextFactory.base);
      })();

      return stopping;
    },
    trigger: async (event) => {
      await stream.trigger({
        ...event,
        workspace: event.workspace ?? definition.workspace,
      });
    },
    ctx: contextFactory.base,
  };

  return handle;
}

/**
 * Re-exported for callers that want relayfile-compatible tools next to `agent()`.
 */
export { NoRetry, relayfileTools, deployAgent };

export { createContextFactory } from './context.js';
export type { CreateContextFactoryOptions, ContextFactory } from './context.js';

export type {
  AgentDefinition,
  AgentHandle,
  AgentOptions,
  AgentPolicy,
  AgentPolicyMode,
  AgentProviderConfig,
  CoalesceMissedTicksMode,
  Context,
  DeployHandle,
  FileSummary,
  HostedAgentDefinition,
  HostedAgentHandler,
  HostedAgentStatus,
  Logger,
  LogFields,
  PostOpts,
  ReplayOnStart,
  RelaycastClient,
  RelaycronClient,
  RelaycronScheduleDefinition,
  RelaycronScheduleHandle,
  RelayfileClient,
  ScheduleSpec,
  WorkspaceFile,
  WriteMeta,
} from './types.js';

export type {
  AgentEvent,
  ChangeEvent,
  CronTickEvent,
  EventType,
  Expansion,
  ExpansionLevel,
  RelaycastMessageEvent,
  RelayfileChangeEvent,
  StartupEvent,
} from '@agent-relay/events';

async function registerSchedules(ctx: Context, schedule: AgentDefinition['schedule']): Promise<void> {
  for (const spec of normalizeSchedules(schedule)) {
    if (typeof spec === 'string') {
      if (looksLikeIsoTimestamp(spec)) {
        await ctx.schedule.at(spec);
      } else {
        await ctx.schedule.every(spec);
      }
      continue;
    }

    if ('cron' in spec) {
      await ctx.schedule.every(spec.cron, undefined, { tz: spec.tz });
      continue;
    }

    await ctx.schedule.at(spec.at);
  }
}

async function registerWatches(
  stream: { registerWatches(watch: WatchRegistration[]): Promise<unknown> },
  watch: AgentDefinition['watch'],
  options: AgentOptions
): Promise<void> {
  const watches = normalizeWatches(watch, options);
  if (watches.length === 0) {
    return;
  }
  await stream.registerWatches(watches);
}

async function registerInboxes(
  stream: { registerInboxes(inbox: string[]): Promise<unknown> },
  inbox: AgentDefinition['inbox']
): Promise<void> {
  const inboxes = normalizeInboxes(inbox);
  if (inboxes.length === 0) {
    return;
  }
  await stream.registerInboxes(inboxes);
}

async function cancelSchedules(ctx: Context, scheduleIds: Set<string>): Promise<void> {
  for (const id of scheduleIds) {
    try {
      await ctx.schedule.cancel(id);
    } catch (error) {
      ctx.logger.warn('failed to cancel schedule during shutdown', {
        scheduleId: id,
        error: normalizeError(error).message,
      });
    }
  }
}

function installSignalHandlers(options: AgentOptions, stop: () => Promise<void>): () => void {
  if (options.handleSignals === false) {
    return () => {};
  }

  const onSignal = () => {
    void stop();
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  };
}

function normalizeSchedules(schedule: ScheduleSpec | ScheduleSpec[] | undefined): ScheduleSpec[] {
  if (!schedule) {
    return [];
  }
  return Array.isArray(schedule) ? schedule : [schedule];
}

function normalizeWatches(watch: AgentDefinition['watch'], options?: AgentOptions): WatchRegistration[] {
  if (!watch) {
    return [];
  }
  const entries = Array.isArray(watch) ? watch : [watch];
  const replayOnStart = normalizeReplayOnStart(options?.replayOnStart);
  const coalesceMs =
    typeof options?.coalesceMs === 'number' && Number.isFinite(options.coalesceMs)
      ? Math.max(0, Math.floor(options.coalesceMs))
      : 200;
  const maxBacklog =
    typeof options?.maxBacklog === 'number' && Number.isFinite(options.maxBacklog)
      ? Math.max(1, Math.floor(options.maxBacklog))
      : undefined;
  const handlerTimeoutMs =
    typeof options?.handlerTimeoutMs === 'number' && Number.isFinite(options.handlerTimeoutMs)
      ? Math.max(1, Math.floor(options.handlerTimeoutMs))
      : undefined;

  return entries
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error('agent.watch must be a string or string[] of globs');
      }
      return entry.trim();
    })
    .filter(Boolean)
    .map((glob) => ({
      glob,
      replayOnStart,
      coalesceMs,
      ...(maxBacklog !== undefined ? { maxBacklog } : {}),
      ...(handlerTimeoutMs !== undefined ? { handlerTimeoutMs } : {}),
    }));
}

function normalizeInboxes(inbox: AgentDefinition['inbox']): string[] {
  if (!inbox) {
    return [];
  }
  return (Array.isArray(inbox) ? inbox : [inbox])
    .map((entry) => {
      if (typeof entry !== 'string') {
        throw new Error('agent.inbox must be a string or string[] of inbox targets');
      }
      const trimmed = entry.trim();
      if (!trimmed) {
        return '';
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('@')) {
        return trimmed;
      }
      return `#${trimmed}`;
    })
    .filter(Boolean);
}

function normalizeReplayOnStart(
  value: AgentOptions['replayOnStart'] | undefined
): NonNullable<AgentOptions['replayOnStart']> {
  const normalized = value?.trim() ?? 'none';
  if (normalized === 'none') {
    return 'none';
  }

  if (normalized.startsWith('last:')) {
    const count = Number.parseInt(normalized.slice('last:'.length), 10);
    if (Number.isFinite(count) && count > 0) {
      return `last:${count}`;
    }
    throw new Error('agent.options.replayOnStart must use "last:<positive-integer>"');
  }

  if (normalized.startsWith('since:')) {
    const since = normalized.slice('since:'.length).trim();
    const parsed = Date.parse(since);
    if (Number.isFinite(parsed)) {
      return `since:${new Date(parsed).toISOString()}`;
    }
    throw new Error('agent.options.replayOnStart must use "since:<iso-timestamp>"');
  }

  throw new Error('agent.options.replayOnStart must be "none", "last:<n>", or "since:<iso-timestamp>"');
}

function looksLikeIsoTimestamp(value: string): boolean {
  return !isNaN(Date.parse(value)) && value.includes('T');
}

function resolveApiKey(options: AgentOptions): string {
  const apiKey = options.apiKey ?? process.env.RELAY_API_KEY;
  if (!apiKey) {
    throw new Error('RELAY_API_KEY is required');
  }
  return apiKey;
}

function sanitizeAgentId(input: string): string {
  return input.trim().replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function assertDefinition(definition: AgentDefinition): void {
  if (!definition.workspace.trim()) {
    throw new Error('agent.workspace is required');
  }
  if (typeof definition.onEvent !== 'function') {
    throw new Error('agent.onEvent is required');
  }
  if (definition.watch !== undefined) {
    const watches = normalizeWatches(definition.watch, definition.options);
    if (watches.length === 0) {
      throw new Error('agent.watch must include at least one non-empty glob');
    }
  }
  if (definition.inbox !== undefined) {
    const inboxes = normalizeInboxes(definition.inbox);
    if (inboxes.length === 0) {
      throw new Error('agent.inbox must include at least one non-empty inbox target');
    }
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(typeof error === 'string' ? error : 'Unknown agent error');
}

function createGatewayRelaycronClient(stream: {
  acquireOnce(key: string): Promise<boolean>;
  releaseOnce(key: string): Promise<void>;
  registerSchedule(
    schedule: string | { cron: string; tz?: string } | { at: string }
  ): Promise<{ id: string }>;
  unregisterSchedules(scheduleIds?: string[]): Promise<void>;
}): RelaycronClient {
  return {
    available: true,
    register: async (definition: RelaycronScheduleDefinition) => {
      if (definition.cron) {
        return stream.registerSchedule(
          definition.tz ? { cron: definition.cron, tz: definition.tz } : definition.cron
        );
      }

      if (definition.at) {
        return stream.registerSchedule({
          at: definition.at instanceof Date ? definition.at.toISOString() : definition.at,
        });
      }

      throw new Error('schedule definition must include cron or at');
    },
    cancel: async (id) => {
      await stream.unregisterSchedules([id]);
    },
  };
}

function createGatewayRelayfileClient(stream: {
  readFile(path: string): Promise<unknown>;
  writeFile(path: string, body: unknown, meta?: Record<string, unknown>): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(glob: string): Promise<unknown[]>;
}): RelayfileClient {
  return {
    available: true,
    read: async (path: string) => normalizeWorkspaceFile(await stream.readFile(path)),
    write: async (path: string, body: unknown, meta?: WriteMeta) => {
      const serialized = serializeWorkspaceBody(body, meta);
      await stream.writeFile(path, serialized.body, serialized.meta as Record<string, unknown> | undefined);
    },
    delete: async (path: string) => stream.deleteFile(path),
    list: async (glob: string) => normalizeFileSummaries(await stream.listFiles(glob)),
  };
}

function createDirectRelayfileClient(
  workspace: string,
  apiKey: string,
  options: AgentOptions
): RelayfileClient {
  const client = new RelayFileSdkClient({
    baseUrl: resolveRelayfileUrl(options),
    token: apiKey,
  });

  return {
    available: true,
    read: async (path) => normalizeWorkspaceFile(await client.readFile(workspace, path)),
    write: async (path, body, meta) => {
      const serialized = serializeWorkspaceBody(body, meta);
      await client.writeFile({
        workspaceId: workspace,
        path,
        content:
          typeof serialized.body === 'string' ? serialized.body : JSON.stringify(serialized.body, null, 2),
        contentType:
          serialized.meta?.contentType ??
          (typeof serialized.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json'),
        encoding: serialized.meta?.encoding ?? 'utf-8',
        baseRevision: serialized.meta?.baseRevision ?? '*',
        ...(serialized.meta?.semantics ? { semantics: serialized.meta.semantics } : {}),
        ...(serialized.meta?.contentIdentity ? { contentIdentity: serialized.meta.contentIdentity } : {}),
      });
    },
    delete: async (path) => {
      await client.deleteFile({
        workspaceId: workspace,
        path,
        baseRevision: '*',
      });
    },
    list: async (glob) =>
      normalizeFileSummaries(
        (
          await client.queryFiles(workspace, {
            path: glob,
          })
        ).items ?? []
      ),
  };
}

function createGatewayRelaycastClient(stream: {
  postMessage(channel: string, text: string, opts?: PostOpts): Promise<{ id: string }>;
  replyMessage(threadId: string, text: string, opts?: PostOpts): Promise<{ id: string }>;
  sendDm(agentOrUser: string, text: string, opts?: PostOpts): Promise<{ id: string }>;
}): RelaycastClient {
  return {
    available: true,
    post: async (channel, text, opts) => stream.postMessage(channel, text, opts),
    reply: async (threadId, text, opts) => stream.replyMessage(threadId, text, opts),
    dm: async (agentOrUser, text, opts) => stream.sendDm(agentOrUser, text, opts),
  };
}

function createDirectRelaycastClient(apiKey: string, options: AgentOptions): RelaycastClient {
  return {
    available: true,
    post: async (channel, text, opts) =>
      relaycastRequest(
        apiKey,
        options,
        '/v1/message',
        {
          channel: channel.startsWith('#') ? channel.slice(1) : channel,
          text,
          mode: 'wait',
        },
        opts
      ),
    reply: async (threadId, text, opts) =>
      relaycastRequest(
        apiKey,
        options,
        '/v1/message/reply',
        {
          messageId: threadId,
          text,
          mode: 'wait',
        },
        opts
      ),
    dm: async (agentOrUser, text, opts) =>
      relaycastRequest(
        apiKey,
        options,
        '/v1/dm',
        {
          to: agentOrUser.startsWith('@') ? agentOrUser.slice(1) : agentOrUser,
          text,
          mode: 'wait',
        },
        opts
      ),
  };
}

async function relaycastRequest(
  apiKey: string,
  options: AgentOptions,
  path: string,
  body: Record<string, unknown>,
  opts?: PostOpts
): Promise<{ id: string }> {
  const idempotencyKey = opts?.idempotencyKey?.trim() || globalThis.crypto.randomUUID();
  const headers = new Headers({
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Idempotency-Key': idempotencyKey,
  });
  const response = await fetch(new URL(path, resolveRelaycastUrl(options)), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`relaycast request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  const id =
    typeof payload?.id === 'string'
      ? payload.id
      : typeof payload?.messageId === 'string'
        ? payload.messageId
        : typeof payload?.message_id === 'string'
          ? payload.message_id
          : null;
  if (!id) {
    throw new Error(`relaycast request did not return a message id for ${path}`);
  }

  return { id };
}

function createGatewayOnceCoordinator(stream: {
  acquireOnce(key: string): Promise<boolean>;
  releaseOnce(key: string): Promise<void>;
}): {
  acquireOnce(key: string): Promise<boolean>;
  releaseOnce(key: string): Promise<void>;
} {
  return {
    acquireOnce: async (key) => stream.acquireOnce(key),
    releaseOnce: async (key) => stream.releaseOnce(key),
  };
}

function resolveRelayfileUrl(options: AgentOptions): string {
  return options.relayfileUrl?.trim() || process.env.RELAYFILE_URL?.trim() || DEFAULT_RELAYFILE_URL;
}

function resolveRelaycastUrl(options: AgentOptions): string {
  return options.relaycastUrl?.trim() || process.env.RELAYCAST_URL?.trim() || DEFAULT_RELAYCAST_URL;
}

function shouldEmitLocalStartup(options: AgentOptions): boolean {
  return typeof options.gatewayUrl === 'string' && options.gatewayUrl.trim().length === 0;
}

function shouldUseGatewayTransport(options: AgentOptions): boolean {
  return !(typeof options.gatewayUrl === 'string' && options.gatewayUrl.trim().length === 0);
}

function normalizeWorkspaceFile(value: unknown): WorkspaceFile | null {
  if (value == null) {
    return null;
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Gateway returned an invalid relayfile read response');
  }

  const record = value as Record<string, unknown>;
  if (typeof record.path !== 'string') {
    throw new Error('Gateway returned a relayfile read response without a path');
  }

  const file: WorkspaceFile = {
    path: record.path,
    body: normalizeWorkspaceBody(record),
  };

  if (typeof record.revision === 'string') {
    file.revision = record.revision;
  }
  if (typeof record.contentType === 'string') {
    file.contentType = record.contentType;
  }
  if (record.encoding === 'utf-8' || record.encoding === 'base64') {
    file.encoding = record.encoding;
  }
  if (record.semantics && typeof record.semantics === 'object' && !Array.isArray(record.semantics)) {
    file.semantics = record.semantics as Record<string, unknown>;
  }

  return file;
}

function normalizeFileSummaries(values: unknown[]): FileSummary[] {
  return values.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('Gateway returned an invalid relayfile list entry');
    }

    const record = value as Record<string, unknown>;
    if (typeof record.path !== 'string') {
      throw new Error('Gateway returned a relayfile list entry without a path');
    }

    const summary: FileSummary = { path: record.path };
    if (record.type === 'file' || record.type === 'dir') {
      summary.type = record.type;
    }
    if (typeof record.revision === 'string') {
      summary.revision = record.revision;
    }
    if (typeof record.provider === 'string') {
      summary.provider = record.provider;
    }
    if (typeof record.providerObjectId === 'string') {
      summary.providerObjectId = record.providerObjectId;
    }
    if (typeof record.size === 'number' && Number.isFinite(record.size)) {
      summary.size = record.size;
    }
    if (typeof record.updatedAt === 'string') {
      summary.updatedAt = record.updatedAt;
    } else if (typeof record.lastEditedAt === 'string') {
      summary.updatedAt = record.lastEditedAt;
    }
    if (typeof record.propertyCount === 'number' && Number.isFinite(record.propertyCount)) {
      summary.propertyCount = record.propertyCount;
    } else if (
      record.properties &&
      typeof record.properties === 'object' &&
      !Array.isArray(record.properties)
    ) {
      summary.propertyCount = Object.keys(record.properties as Record<string, unknown>).length;
    }
    if (typeof record.relationCount === 'number' && Number.isFinite(record.relationCount)) {
      summary.relationCount = record.relationCount;
    } else if (Array.isArray(record.relations)) {
      summary.relationCount = record.relations.length;
    }
    if (typeof record.permissionCount === 'number' && Number.isFinite(record.permissionCount)) {
      summary.permissionCount = record.permissionCount;
    } else if (Array.isArray(record.permissions)) {
      summary.permissionCount = record.permissions.length;
    }
    if (typeof record.commentCount === 'number' && Number.isFinite(record.commentCount)) {
      summary.commentCount = record.commentCount;
    } else if (Array.isArray(record.comments)) {
      summary.commentCount = record.comments.length;
    }

    return summary;
  });
}

function normalizeWorkspaceBody(record: Record<string, unknown>): unknown {
  if ('body' in record) {
    return record.body;
  }

  const content = record.content;
  if (typeof content !== 'string') {
    throw new Error('Gateway returned a relayfile read response without file content');
  }

  const encoding = record.encoding === 'utf-8' || record.encoding === 'base64' ? record.encoding : undefined;
  const contentType = typeof record.contentType === 'string' ? record.contentType : undefined;

  if (encoding === 'base64') {
    return content;
  }
  if (looksLikeJsonContentType(contentType)) {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }

  return content;
}

function serializeWorkspaceBody(body: unknown, meta?: WriteMeta): { body: string; meta?: WriteMeta } {
  if (typeof body === 'string') {
    return { body, meta };
  }

  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    return {
      body: Buffer.from(bytes).toString('base64'),
      meta: {
        ...meta,
        contentType: meta?.contentType ?? 'application/octet-stream',
        encoding: meta?.encoding ?? 'base64',
      },
    };
  }

  return {
    body: JSON.stringify(body),
    meta: {
      ...meta,
      contentType: meta?.contentType ?? 'application/json',
      encoding: meta?.encoding ?? 'utf-8',
    },
  };
}

function looksLikeJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return normalized.includes('/json') || normalized.endsWith('+json');
}
