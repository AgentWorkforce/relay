import { SpanKind } from '@opentelemetry/api';
import {
  createAgentEvent,
  createTransportErrorEvent,
  toAgentEventRecord,
  type AgentEventRecord,
} from './envelope.js';
import {
  extractTraceContextFromCarrier,
  injectTraceContextIntoCarrier,
  initializeRuntimeOtel,
  withRuntimeSpan,
} from './otel.js';
import { withRetry } from './retry.js';
import type {
  AgentEvent,
  EventStreamHandle,
  EventStreamOptions,
  Expansion,
  ExpansionOptionsForLevel,
  ExpansionLevel,
  GatewayRegistrationResult,
  NoRetry,
  StructuredLogEntry,
  ThreadExpansionOptions,
  WebSocketFactory,
} from './types.js';

const DEFAULT_GATEWAY_URL = 'ws://127.0.0.1:8787/v1/agent-events';
const READY_FALLBACK_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;

type GatewayMessage =
  | { type: 'connected' }
  | { type: 'auth_ok'; workspace?: string; agentId?: string }
  | { type: 'subscribed'; workspace?: string; agentId?: string }
  | { type: 'ping' }
  | { type: 'once_result'; requestId?: string; acquired: boolean }
  | { type: 'event'; event: AgentEventRecord }
  | { type: 'events'; events: AgentEventRecord[] }
  | { type: 'delivery_failed'; error: string; event: AgentEventRecord }
  | {
      type: 'registered';
      schedules?: Array<{ gatewayScheduleId?: string }>;
      watches?: unknown[];
      inbox?: string[];
    }
  | { type: 'unregistered'; scheduleIds?: string[] }
  | { type: 'expand_result'; requestId?: string; expansion: Expansion }
  | { type: 'expand_error'; requestId?: string; code?: string; message: string }
  | { type: 'files_read_result'; requestId?: string; file: unknown }
  | { type: 'files_write_result'; requestId?: string }
  | { type: 'files_delete_result'; requestId?: string }
  | { type: 'files_list_result'; requestId?: string; entries?: unknown[]; items?: unknown[] }
  | { type: 'files_error'; requestId?: string; code?: string; message: string }
  | { type: 'messages_result'; requestId?: string; id: string }
  | { type: 'messages_error'; requestId?: string; code?: string; message: string }
  | { type: 'approval_result'; requestId?: string; approval: unknown }
  | { type: 'approval_error'; requestId?: string; code?: string; message: string }
  | { type: 'error'; error: string; code?: string; message?: string };

interface PendingRequest<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

/**
 * Opens a normalized event stream over the runtime gateway websocket.
 */
export function events(options: EventStreamOptions): EventStreamHandle {
  initializeRuntimeOtel();

  const apiKey = resolveApiKey(options.apiKey);
  const gatewayUrl = resolveGatewayUrl(options.gatewayUrl);
  const webSocketFactory = resolveWebSocketFactory(options.webSocketFactory);
  const expansionCache = new Map<string, Promise<unknown>>();

  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let readyFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let closed = false;
  const pendingRegisterRequests: Array<PendingRequest<GatewayRegistrationResult>> = [];
  const pendingUnregisterRequests: Array<PendingRequest<void>> = [];
  const pendingOnceRequests = new Map<
    string,
    { resolve: (acquired: boolean) => void; reject: (error: Error) => void }
  >();
  const pendingExpansionRequests = new Map<string, PendingRequest<Expansion>>();
  const pendingFileReadRequests = new Map<string, PendingRequest<unknown>>();
  const pendingFileWriteRequests = new Map<string, PendingRequest<void>>();
  const pendingFileDeleteRequests = new Map<string, PendingRequest<void>>();
  const pendingFileListRequests = new Map<string, PendingRequest<unknown[]>>();
  const pendingMessageRequests = new Map<string, PendingRequest<{ id: string }>>();
  const pendingApprovalRequests = new Map<string, PendingRequest<unknown>>();
  const pendingLogs: StructuredLogEntry[] = [];

  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const markReady = () => {
    if (!resolveReady) {
      return;
    }

    const resolve = resolveReady;
    resolveReady = null;
    resolve();
  };

  const closeSocket = () => {
    if (readyFallbackTimer) {
      clearTimeout(readyFallbackTimer);
      readyFallbackTimer = null;
    }

    if (!socket) {
      return;
    }

    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close();
    socket = null;
  };

  const rejectPendingControls = (error: Error) => {
    while (pendingRegisterRequests.length > 0) {
      pendingRegisterRequests.shift()?.reject(error);
    }
    while (pendingUnregisterRequests.length > 0) {
      pendingUnregisterRequests.shift()?.reject(error);
    }
    for (const [requestId, pending] of pendingOnceRequests.entries()) {
      pending.reject(error);
      pendingOnceRequests.delete(requestId);
    }
    rejectPendingMap(pendingExpansionRequests, error);
    rejectPendingMap(pendingFileReadRequests, error);
    rejectPendingMap(pendingFileWriteRequests, error);
    rejectPendingMap(pendingFileDeleteRequests, error);
    rejectPendingMap(pendingFileListRequests, error);
    rejectPendingMap(pendingMessageRequests, error);
    rejectPendingMap(pendingApprovalRequests, error);
  };

  const sendGatewayMessage = (message: Record<string, unknown>) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway websocket is not connected');
    }
    socket.send(JSON.stringify(message));
  };

  const flushPendingLogs = () => {
    while (pendingLogs.length > 0) {
      const next = pendingLogs[0];
      try {
        sendGatewayMessage({
          type: 'log',
          entry: next,
        });
        pendingLogs.shift();
      } catch {
        return;
      }
    }
  };

  const publishLog = (entry: StructuredLogEntry) => {
    if (closed) {
      return;
    }

    pendingLogs.push(entry);
    if (pendingLogs.length > 1_000) {
      pendingLogs.splice(0, pendingLogs.length - 1_000);
    }
    flushPendingLogs();
  };

  const dispatchLocally = async (input: AgentEvent | Partial<AgentEvent>): Promise<void> => {
    const seed = isAgentEvent(input)
      ? input
      : createAgentEvent(normalizePartialEvent(input, options.workspace), {
          expansionCache: expansionCache as Map<string, Promise<any>>,
        });

    try {
      await deliverWithRetry(
        seed,
        options.onEvent,
        options.signal,
        expansionCache as Map<string, Promise<any>>
      );
    } catch (error) {
      await options.onError?.(error, seed);
      throw error;
    }
  };

  const deliverRemote = async (record: AgentEventRecord): Promise<void> => {
    const eventId =
      record.id ??
      toAgentEventRecord(
        createAgentEvent(record, {
          expansionCache: expansionCache as Map<string, Promise<any>>,
        })
      ).id ??
      globalThis.crypto.randomUUID();
    const expansionLoaders = {
      loadFull: () => handle.requestExpansion(eventId, 'full'),
      loadDiff: () => handle.requestExpansion(eventId, 'diff'),
      loadThread: (threadOptions?: ThreadExpansionOptions) =>
        handle.requestExpansion(eventId, 'thread', threadOptions),
    };
    const event = createAgentEvent(
      { ...record, id: eventId },
      {
        expansionCache: expansionCache as Map<string, Promise<any>>,
        ...expansionLoaders,
      }
    );

    await withRuntimeSpan(
      'agent.sdk.event.delivery',
      {
        kind: SpanKind.CONSUMER,
        context: extractTraceContextFromCarrier(record as unknown as Record<string, unknown>),
        attributes: createEventSpanAttributes(event),
      },
      async () => {
        try {
          await deliverWithRetry(
            event,
            options.onEvent,
            options.signal,
            expansionCache as Map<string, Promise<any>>,
            expansionLoaders
          );
          sendGatewayMessage({
            type: 'ack',
            eventId: event.id,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          try {
            sendGatewayMessage({
              type: 'nack',
              eventId: event.id,
              ...(message.trim() ? { error: message } : {}),
              ...(isNoRetryError(error) ? { noRetry: true } : {}),
            });
          } catch (nackError) {
            await reportTransportError(nackError, 'transport.delivery.nack_failed');
          }
        }
      }
    );
  };

  const reportTransportError = async (error: unknown, detail: string) => {
    await options.onError?.(
      error,
      createTransportErrorEvent({
        workspace: options.workspace,
        detail,
      })
    );
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) {
      return;
    }

    reconnectAttempt += 1;
    const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(reconnectAttempt - 1, 5));

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delayMs);
  };

  const handleGatewayMessage = async (message: GatewayMessage) => {
    switch (message.type) {
      case 'connected':
      case 'auth_ok':
      case 'subscribed':
        reconnectAttempt = 0;
        flushPendingLogs();
        markReady();
        return;
      case 'ping':
        socket?.send(JSON.stringify({ type: 'pong' }));
        return;
      case 'once_result': {
        const requestId = message.requestId?.trim();
        if (!requestId) {
          return;
        }
        const pending = pendingOnceRequests.get(requestId);
        if (!pending) {
          return;
        }
        pendingOnceRequests.delete(requestId);
        pending.resolve(message.acquired);
        return;
      }
      case 'event':
        await deliverRemote(message.event);
        return;
      case 'events':
        for (const record of message.events) {
          await deliverRemote(record);
        }
        return;
      case 'delivery_failed':
        await options.onError?.(
          new Error(message.error),
          createAgentEvent(message.event, {
            expansionCache: expansionCache as Map<string, Promise<any>>,
          })
        );
        return;
      case 'registered': {
        const pending = pendingRegisterRequests.shift();
        if (!pending) {
          return;
        }
        pending.resolve({
          ...(message.schedules ? { schedules: message.schedules } : {}),
          ...(message.watches ? { watches: message.watches } : {}),
          ...(message.inbox ? { inbox: message.inbox } : {}),
        });
        return;
      }
      case 'unregistered':
        pendingUnregisterRequests.shift()?.resolve();
        return;
      case 'expand_result':
        resolvePendingMapValue(pendingExpansionRequests, message.requestId, message.expansion);
        return;
      case 'expand_error':
        rejectPendingMapValue(
          pendingExpansionRequests,
          message.requestId,
          formatGatewayError(message.code, message.message)
        );
        return;
      case 'files_read_result':
        resolvePendingMapValue(pendingFileReadRequests, message.requestId, message.file);
        return;
      case 'files_write_result':
        resolvePendingMapValue(pendingFileWriteRequests, message.requestId, undefined);
        return;
      case 'files_delete_result':
        resolvePendingMapValue(pendingFileDeleteRequests, message.requestId, undefined);
        return;
      case 'files_list_result':
        resolvePendingMapValue(
          pendingFileListRequests,
          message.requestId,
          Array.isArray(message.entries) ? message.entries : Array.isArray(message.items) ? message.items : []
        );
        return;
      case 'files_error':
        rejectRpcRequest(
          [
            pendingFileReadRequests,
            pendingFileWriteRequests,
            pendingFileDeleteRequests,
            pendingFileListRequests,
          ],
          message.requestId,
          message.code,
          message.message
        );
        return;
      case 'messages_result':
        resolvePendingMapValue(pendingMessageRequests, message.requestId, { id: message.id });
        return;
      case 'messages_error':
        rejectRpcRequest([pendingMessageRequests], message.requestId, message.code, message.message);
        return;
      case 'approval_result':
        resolvePendingMapValue(pendingApprovalRequests, message.requestId, message.approval);
        return;
      case 'approval_error':
        rejectRpcRequest([pendingApprovalRequests], message.requestId, message.code, message.message);
        return;
      case 'error':
        rejectPendingControls(new Error(message.error));
        throw new Error(message.error);
      default: {
        const exhaustive: never = message;
        throw new Error(`Unsupported gateway message: ${JSON.stringify(exhaustive)}`);
      }
    }
  };

  const openSocket = () => {
    if (closed) {
      return;
    }

    if (!gatewayUrl || !webSocketFactory) {
      void reportTransportError(
        new Error(
          gatewayUrl
            ? 'WebSocket is not available in this runtime'
            : 'Event gateway transport is disabled for this runtime'
        ),
        gatewayUrl ? 'transport.websocket.unavailable' : 'transport.gateway.disabled'
      );
      markReady();
      return;
    }

    closeSocket();
    socket = webSocketFactory(gatewayUrl);

    socket.onopen = () => {
      reconnectAttempt = 0;
      socket?.send(
        JSON.stringify({
          type: 'subscribe',
          workspace: options.workspace,
          agentId: options.agentId ?? options.workspace,
          apiKey,
        })
      );
      readyFallbackTimer = setTimeout(markReady, READY_FALLBACK_MS);
      flushPendingLogs();
    };

    socket.onmessage = (message) => {
      try {
        const raw = typeof message.data === 'string' ? message.data : String(message.data);
        const parsed = JSON.parse(raw) as GatewayMessage;
        void handleGatewayMessage(parsed).catch((error) => {
          void reportTransportError(error, 'transport.delivery.error');
        });
      } catch (error) {
        void reportTransportError(error, 'transport.parse.error');
      }
    };

    socket.onerror = () => {
      rejectPendingControls(new Error('Gateway websocket error'));
      scheduleReconnect();
    };

    socket.onclose = () => {
      rejectPendingControls(new Error('Gateway websocket closed'));
      closeSocket();
      if (!closed) {
        scheduleReconnect();
      }
    };
  };

  if (options.signal) {
    if (options.signal.aborted) {
      closed = true;
      markReady();
    } else {
      options.signal.addEventListener(
        'abort',
        () => {
          void handle.close();
        },
        { once: true }
      );
    }
  }

  const handle: EventStreamHandle = {
    ready,
    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectPendingControls(new Error('Gateway websocket closed'));
      closeSocket();
      markReady();
    },
    acquireOnce: async (key) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return await withRuntimeSpan(
        'agent.sdk.ctx.once.acquire',
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'relay.request_id': requestId,
            'relay.once_key': key,
          },
        },
        async () =>
          await new Promise<boolean>((resolve, reject) => {
            pendingOnceRequests.set(requestId, { resolve, reject });
            try {
              sendGatewayMessage(
                injectTraceContextIntoCarrier({
                  type: 'once',
                  requestId,
                  key,
                })
              );
            } catch (error) {
              pendingOnceRequests.delete(requestId);
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          })
      );
    },
    releaseOnce: async (key) => {
      await ready;
      await withRuntimeSpan(
        'agent.sdk.ctx.once.release',
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'relay.once_key': key,
          },
        },
        async () => {
          sendGatewayMessage(
            injectTraceContextIntoCarrier({
              type: 'once_release',
              key,
            })
          );
        }
      );
    },
    registerSchedule: async (schedule) => {
      await ready;
      return await withRuntimeSpan(
        'agent.sdk.ctx.schedule.register',
        {
          kind: SpanKind.CLIENT,
          attributes: createScheduleSpanAttributes(schedule),
        },
        async () =>
          await new Promise<{ id: string }>((resolve, reject) => {
            pendingRegisterRequests.push({
              resolve: (result) => {
                const id = result.schedules?.[0]?.gatewayScheduleId?.trim();
                if (!id) {
                  reject(new Error('Gateway did not return a schedule id'));
                  return;
                }
                resolve({ id });
              },
              reject,
            });
            try {
              sendGatewayMessage(
                injectTraceContextIntoCarrier({
                  type: 'register',
                  schedule,
                })
              );
            } catch (error) {
              pendingRegisterRequests.pop();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          })
      );
    },
    registerWatches: async (watch) => {
      await ready;
      return await new Promise<GatewayRegistrationResult>((resolve, reject) => {
        pendingRegisterRequests.push({ resolve, reject });
        try {
          sendGatewayMessage({
            type: 'register',
            watch,
          });
        } catch (error) {
          pendingRegisterRequests.pop();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    registerInboxes: async (inbox) => {
      await ready;
      return await new Promise<GatewayRegistrationResult>((resolve, reject) => {
        pendingRegisterRequests.push({ resolve, reject });
        try {
          sendGatewayMessage({
            type: 'register',
            inbox,
          });
        } catch (error) {
          pendingRegisterRequests.pop();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    unregisterSchedules: async (scheduleIds) => {
      await ready;
      return await withRuntimeSpan(
        'agent.sdk.ctx.schedule.unregister',
        {
          kind: SpanKind.CLIENT,
          attributes: {
            ...(scheduleIds?.length ? { 'relay.schedule_ids': scheduleIds.join(',') } : {}),
          },
        },
        async () =>
          await new Promise<void>((resolve, reject) => {
            pendingUnregisterRequests.push({ resolve, reject });
            try {
              sendGatewayMessage(
                injectTraceContextIntoCarrier({
                  type: 'unregister',
                  ...(scheduleIds ? { scheduleIds } : {}),
                })
              );
            } catch (error) {
              pendingUnregisterRequests.pop();
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          })
      );
    },
    requestExpansion: async <L extends Exclude<ExpansionLevel, 'summary'>>(
      eventId: string,
      level: L,
      options?: ExpansionOptionsForLevel<L>
    ): Promise<Expansion<L>> => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return (await runGatewayRpc(
        'agent.sdk.ctx.expand',
        {
          'relay.request_id': requestId,
          'relay.event_id': eventId,
          'relay.expand_level': level,
        },
        pendingExpansionRequests,
        requestId,
        {
          type: 'expand',
          requestId,
          eventId,
          level,
          ...(level === 'thread' && options ? { params: options as ThreadExpansionOptions } : {}),
        },
        sendGatewayMessage
      )) as Expansion<L>;
    },
    readFile: async (path) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return await runGatewayRpc(
        'agent.sdk.ctx.files.read',
        {
          'relay.request_id': requestId,
          'relay.file_path': path,
        },
        pendingFileReadRequests,
        requestId,
        {
          type: 'files_read',
          requestId,
          path,
        },
        sendGatewayMessage
      );
    },
    writeFile: async (path, body, meta) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      await runGatewayRpc(
        'agent.sdk.ctx.files.write',
        {
          'relay.request_id': requestId,
          'relay.file_path': path,
        },
        pendingFileWriteRequests,
        requestId,
        {
          type: 'files_write',
          requestId,
          path,
          body,
          ...(meta ? { meta } : {}),
        },
        sendGatewayMessage
      );
    },
    deleteFile: async (path) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      await runGatewayRpc(
        'agent.sdk.ctx.files.delete',
        {
          'relay.request_id': requestId,
          'relay.file_path': path,
        },
        pendingFileDeleteRequests,
        requestId,
        {
          type: 'files_delete',
          requestId,
          path,
        },
        sendGatewayMessage
      );
    },
    listFiles: async (glob) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return await runGatewayRpc(
        'agent.sdk.ctx.files.list',
        {
          'relay.request_id': requestId,
          'relay.file_glob': glob,
        },
        pendingFileListRequests,
        requestId,
        {
          type: 'files_list',
          requestId,
          glob,
        },
        sendGatewayMessage
      );
    },
    publishLog,
    postMessage: async (channel, text, opts) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return await runGatewayRpc(
        'agent.sdk.ctx.messages.post',
        {
          'relay.request_id': requestId,
          'relay.channel': channel,
        },
        pendingMessageRequests,
        requestId,
        {
          type: 'messages_post',
          requestId,
          channel,
          text,
          ...(opts?.idempotencyKey ? { opts: { idempotencyKey: opts.idempotencyKey } } : {}),
        },
        sendGatewayMessage
      );
    },
    replyMessage: async (threadId, text, opts) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return await runGatewayRpc(
        'agent.sdk.ctx.messages.reply',
        {
          'relay.request_id': requestId,
          'relay.thread_id': threadId,
        },
        pendingMessageRequests,
        requestId,
        {
          type: 'messages_reply',
          requestId,
          threadId,
          text,
          ...(opts?.idempotencyKey ? { opts: { idempotencyKey: opts.idempotencyKey } } : {}),
        },
        sendGatewayMessage
      );
    },
    sendDm: async (agentOrUser, text, opts) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return await runGatewayRpc(
        'agent.sdk.ctx.messages.dm',
        {
          'relay.request_id': requestId,
          'relay.dm_target': agentOrUser,
        },
        pendingMessageRequests,
        requestId,
        {
          type: 'messages_dm',
          requestId,
          agentOrUser,
          text,
          ...(opts?.idempotencyKey ? { opts: { idempotencyKey: opts.idempotencyKey } } : {}),
        },
        sendGatewayMessage
      );
    },
    awaitApproval: async (approvalId) => {
      await ready;
      const requestId = globalThis.crypto.randomUUID();
      return await runGatewayRpc(
        'agent.sdk.ctx.approval.wait',
        {
          'relay.request_id': requestId,
          'relay.approval_id': approvalId,
        },
        pendingApprovalRequests,
        requestId,
        {
          type: 'approval_wait',
          requestId,
          approvalId,
        },
        sendGatewayMessage
      );
    },
    trigger: async (event) => {
      await dispatchLocally(event);
    },
  };

  openSocket();
  return handle;
}

function resolveApiKey(apiKey?: string): string {
  const resolved = apiKey ?? process.env.RELAY_API_KEY;
  if (!resolved) {
    throw new Error('RELAY_API_KEY is required');
  }
  return resolved;
}

function resolveGatewayUrl(gatewayUrl?: string): string | null {
  const resolved = gatewayUrl ?? process.env.RELAY_AGENT_EVENTS_URL ?? DEFAULT_GATEWAY_URL;
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveWebSocketFactory(factory?: WebSocketFactory): WebSocketFactory | null {
  if (factory) {
    return factory;
  }
  if (typeof globalThis.WebSocket === 'function') {
    return (url) => new globalThis.WebSocket(url);
  }
  return null;
}

function isNoRetryError(error: unknown): error is NoRetry {
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'NoRetry');
}

function isAgentEvent(value: AgentEvent | Partial<AgentEvent>): value is AgentEvent {
  return (
    typeof value.id === 'string' &&
    typeof value.workspace === 'string' &&
    typeof value.type === 'string' &&
    typeof value.occurredAt === 'string' &&
    typeof value.attempt === 'number' &&
    typeof value.resource === 'object' &&
    value.resource !== null &&
    typeof value.summary === 'object' &&
    value.summary !== null &&
    typeof value.expand === 'function'
  );
}

function createEventSpanAttributes(event: {
  workspace: string;
  type: string;
  id: string;
  attempt?: number;
  agentId?: string;
  path?: string;
  resource: {
    kind?: string;
    provider?: string;
    path?: string;
  };
}): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    'relay.workspace': event.workspace,
    'relay.event_type': event.type,
    'relay.event_id': event.id,
  };

  if (event.agentId) {
    attributes['relay.agent_id'] = event.agentId;
  }
  if (event.path) {
    attributes['relay.resource_path'] = event.path;
  }
  if (event.resource.kind) {
    attributes['relay.resource_kind'] = event.resource.kind;
  }
  if (event.resource.provider) {
    attributes['relay.provider'] = event.resource.provider;
  }
  if (typeof event.attempt === 'number') {
    attributes['relay.delivery_attempt'] = event.attempt;
  }

  return attributes;
}

function normalizePartialEvent(event: Partial<AgentEvent>, workspace: string): AgentEventRecord {
  const record = event as AgentEvent & Record<string, unknown>;

  return {
    id: event.id,
    workspace: event.workspace ?? workspace,
    type: event.type ?? 'startup',
    occurredAt: event.occurredAt,
    attempt: event.attempt,
    resource: event.resource ? { ...event.resource } : undefined,
    summary: event.summary ? { ...event.summary } : undefined,
    digest: event.digest,
    schedule: typeof record.schedule === 'string' ? record.schedule : undefined,
    scheduledFor: typeof record.scheduledFor === 'string' ? record.scheduledFor : undefined,
    reason:
      record.reason === 'cold-start' || record.reason === 'redeploy' || record.reason === 'manual'
        ? record.reason
        : undefined,
    path: typeof record.path === 'string' ? record.path : undefined,
    watch: typeof record.watch === 'string' ? record.watch : undefined,
    action:
      record.action === 'created' || record.action === 'updated' || record.action === 'deleted'
        ? record.action
        : undefined,
    agentId: typeof record.agentId === 'string' ? record.agentId : undefined,
    channel: typeof record.channel === 'string' ? record.channel : undefined,
    messageId: typeof record.messageId === 'string' ? record.messageId : undefined,
    threadId: typeof record.threadId === 'string' ? record.threadId : undefined,
    detail: typeof record.detail === 'string' ? record.detail : undefined,
  };
}

async function deliverWithRetry(
  seed: AgentEvent,
  onEvent: (event: AgentEvent) => Promise<void> | void,
  signal: AbortSignal | undefined,
  expansionCache: Map<string, Promise<any>>,
  expansionLoaders?: {
    loadFull?: () => Promise<Expansion<'full'>>;
    loadDiff?: () => Promise<Expansion<'diff'>>;
  }
): Promise<void> {
  await withRetry(
    async (attempt) => {
      const attemptEvent =
        attempt === seed.attempt
          ? seed
          : createAgentEvent(
              { ...toAgentEventRecord(seed), attempt },
              {
                expansionCache,
                ...expansionLoaders,
              }
            );
      await withRuntimeSpan(
        'agent.sdk.event.handler',
        {
          attributes: {
            ...createEventSpanAttributes(attemptEvent),
            'relay.delivery_attempt': attempt,
          },
        },
        async () => {
          await onEvent(attemptEvent);
        }
      );
    },
    undefined,
    signal
  );
}

async function runGatewayRpc<T>(
  spanName: string,
  attributes: Record<string, string>,
  pending: Map<string, PendingRequest<T>>,
  requestId: string,
  message: Record<string, unknown>,
  sendGatewayMessage: (message: Record<string, unknown>) => void
): Promise<T> {
  return await withRuntimeSpan(
    spanName,
    {
      kind: SpanKind.CLIENT,
      attributes,
    },
    async () =>
      await awaitGatewayRpc(pending, requestId, injectTraceContextIntoCarrier(message), sendGatewayMessage)
  );
}

function rejectPendingMap<T>(pending: Map<string, PendingRequest<T>>, error: Error): void {
  for (const [requestId, request] of pending.entries()) {
    request.reject(error);
    pending.delete(requestId);
  }
}

function resolvePendingMapValue<T>(
  pending: Map<string, PendingRequest<T>>,
  requestId: string | undefined,
  value: T
): void {
  const normalized = requestId?.trim();
  if (!normalized) {
    return;
  }
  const request = pending.get(normalized);
  if (!request) {
    return;
  }
  pending.delete(normalized);
  request.resolve(value);
}

function rejectPendingMapValue<T>(
  pending: Map<string, PendingRequest<T>>,
  requestId: string | undefined,
  error: Error
): void {
  const normalized = requestId?.trim();
  if (!normalized) {
    return;
  }
  const request = pending.get(normalized);
  if (!request) {
    return;
  }
  pending.delete(normalized);
  request.reject(error);
}

function rejectRpcRequest(
  pendingMaps: Array<Map<string, PendingRequest<any>>>,
  requestId: string | undefined,
  code: string | undefined,
  message: string
): void {
  const error = formatGatewayError(code, message);
  for (const pending of pendingMaps) {
    rejectPendingMapValue(pending, requestId, error);
  }
}

async function awaitGatewayRpc<T>(
  pending: Map<string, PendingRequest<T>>,
  requestId: string,
  message: Record<string, unknown>,
  sendGatewayMessage: (message: Record<string, unknown>) => void
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    try {
      sendGatewayMessage(message);
    } catch (error) {
      pending.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function formatGatewayError(code: string | undefined, message: string): Error {
  return new Error(code?.trim() ? `${code}: ${message}` : message);
}

function createScheduleSpanAttributes(
  schedule: string | { cron: string; tz?: string } | { at: string }
): Record<string, string> {
  if (typeof schedule === 'string') {
    return { 'relay.schedule': schedule };
  }

  if ('cron' in schedule) {
    return {
      'relay.schedule': schedule.cron,
      ...(schedule.tz ? { 'relay.schedule_tz': schedule.tz } : {}),
    };
  }

  return {
    'relay.schedule_at': schedule.at,
  };
}
