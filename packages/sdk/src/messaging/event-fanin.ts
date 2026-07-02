import type {
  RelayMessagingEvent,
  RelayMessagingEventMap,
  RelayMessagingEventsSurface,
} from './types.js';

/**
 * Options for {@link createEventFanIn}.
 */
export interface EventFanInOptions {
  /**
   * Window in which identical events arriving from different sources are
   * collapsed into one emission. Cross-source duplicates of the same server
   * event arrive within milliseconds of each other; legitimate repeats
   * (re-reactions, presence flaps) are separated by far more than this.
   */
  dedupeWindowMs?: number;
  /** Maximum number of tracked dedupe keys before the oldest are evicted. */
  dedupeCapacity?: number;
  /**
   * How long after `connect()` to wait for a registered-agent source before
   * reporting that the stream has nothing real to connect to.
   */
  noSourceWarningMs?: number;
  /** Receives source connect/subscribe failures and the no-source warning. */
  onError?: (error: unknown) => void;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * A {@link RelayMessagingEventsSurface} that fans in events from every
 * registered agent's messaging client.
 *
 * Relaycast v5 delivers events over each agent's node transport
 * (`/v1/node/ws`); the legacy workspace stream (`/v1/ws`) rejects workspace
 * keys, so a workspace-scoped client on its own can never receive channel
 * messages. The fan-in makes `relay.addListener(...)` work by streaming
 * through the registered agents instead: each agent client added via
 * `addSource` is connected (once `connect()` has been requested) and its
 * events are forwarded, deduplicated across sources so a message delivered to
 * several locally-registered agents surfaces once.
 */
export interface RelayEventFanIn extends RelayMessagingEventsSurface {
  /** Add a registered agent's events surface. Idempotent per surface. */
  addSource(source: RelayMessagingEventsSurface): void;
  /** Whether any registered-agent sources have been added. */
  hasAgentSources(): boolean;
}

const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
const DEFAULT_DEDUPE_CAPACITY = 2048;
const DEFAULT_NO_SOURCE_WARNING_MS = 10_000;

/**
 * Derive a cross-source identity for an event, or `null` for events that must
 * never be deduplicated (per-connection transport state, unknown frames).
 */
function dedupeKey(event: RelayMessagingEvent): string | null {
  switch (event.type) {
    case 'messageCreated':
    case 'messageUpdated':
    case 'threadReply':
      return event.message?.messageId ? `${event.type}:${event.message.messageId}` : null;
    case 'dmReceived':
    case 'groupDmReceived':
      return event.message?.messageId
        ? `${event.type}:${event.conversationId}:${event.message.messageId}`
        : null;
    case 'messageRead':
      return `${event.type}:${event.messageId}:${event.agentName}`;
    case 'reactionAdded':
    case 'reactionRemoved':
      return `${event.type}:${event.messageId}:${event.emoji}:${event.agentName}`;
    case 'agentOnline':
    case 'agentOffline':
      return `${event.type}:${event.agent?.name}`;
    case 'agentSpawnRequested':
    case 'agentReleaseRequested':
      return `${event.type}:${event.agent?.name}`;
    case 'channelCreated':
    case 'channelUpdated':
    case 'channelArchived':
      return `${event.type}:${event.channel?.name}`;
    case 'memberJoined':
    case 'memberLeft':
    case 'channelMuted':
    case 'channelUnmuted':
      return `${event.type}:${event.channel}:${event.agentName}`;
    case 'actionInvoked':
      return `${event.type}:${event.invocationId}`;
    default:
      // connected / disconnected / error / reconnecting /
      // permanentlyDisconnected / unknown: per-source transport state.
      return null;
  }
}

/**
 * Create an events fan-in.
 *
 * @param fallback - The workspace-scoped client's events surface, used only
 *   while no agent sources exist (it may still work against servers that
 *   accept the workspace stream). It is detached as soon as the first agent
 *   source connects.
 */
export function createEventFanIn(
  fallback: RelayMessagingEventsSurface | undefined,
  options: EventFanInOptions = {}
): RelayEventFanIn {
  const dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const dedupeCapacity = options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY;
  const noSourceWarningMs = options.noSourceWarningMs ?? DEFAULT_NO_SOURCE_WARNING_MS;
  const now = options.now ?? (() => Date.now());

  const handlers = new Map<string, Set<(event: RelayMessagingEvent) => void | Promise<void>>>();
  const sources: RelayMessagingEventsSurface[] = [];
  const seenSources = new Set<RelayMessagingEventsSurface>();
  const desiredChannels = new Set<string>();
  /** Dedupe keys → last-seen timestamp, insertion-ordered for eviction. */
  const seenEvents = new Map<string, number>();

  let connectRequested = false;
  let fallbackForwarding: (() => void) | undefined;
  let fallbackConnected = false;
  let noSourceTimer: ReturnType<typeof setTimeout> | undefined;

  const report = (error: unknown): void => {
    if (options.onError) {
      try {
        options.onError(error);
      } catch {
        // Error hooks must not throw into the event source.
      }
      return;
    }
    console.warn('[agent-relay] event stream:', error);
  };

  const emitLocal = (event: RelayMessagingEvent): void => {
    for (const key of [event.type, 'any'] as const) {
      for (const handler of handlers.get(key) ?? []) {
        try {
          void Promise.resolve(handler(event)).catch(report);
        } catch (error) {
          report(error);
        }
      }
    }
  };

  const forward = (event: RelayMessagingEvent): void => {
    const key = dedupeKey(event);
    if (key) {
      const at = now();
      const prev = seenEvents.get(key);
      if (prev !== undefined && at - prev < dedupeWindowMs) return;
      seenEvents.delete(key);
      seenEvents.set(key, at);
      while (seenEvents.size > dedupeCapacity) {
        const oldest = seenEvents.keys().next().value;
        if (oldest === undefined) break;
        seenEvents.delete(oldest);
      }
    }
    emitLocal(event);
  };

  const clearNoSourceTimer = (): void => {
    if (noSourceTimer !== undefined) {
      clearTimeout(noSourceTimer);
      noSourceTimer = undefined;
    }
  };

  const scheduleNoSourceWarning = (): void => {
    if (noSourceTimer !== undefined || noSourceWarningMs <= 0) return;
    noSourceTimer = setTimeout(() => {
      noSourceTimer = undefined;
      if (!connectRequested || sources.length > 0) return;
      report(
        new Error(
          'Listening for relay events, but no registered agent is connected. ' +
            'Relaycast delivers events over each agent\'s node transport, and the ' +
            'workspace-key stream cannot receive them. Register an agent first ' +
            '(`relay.workspace.register(...)` / `workspace.reconnect(...)`) so the ' +
            'listener has a live connection to stream through.'
        )
      );
    }, noSourceWarningMs);
    (noSourceTimer as { unref?: () => void }).unref?.();
  };

  const connectSource = (source: RelayMessagingEventsSurface): void => {
    if (typeof source.connect === 'function') {
      try {
        source.connect();
      } catch (error) {
        report(error);
      }
    }
    if (desiredChannels.size > 0 && typeof source.subscribe === 'function') {
      try {
        source.subscribe([...desiredChannels]);
      } catch (error) {
        report(error);
      }
    }
  };

  const attachFallback = (): void => {
    // Injected fakes may carry a partial surface; only a stream that can be
    // observed is worth attaching.
    if (!fallback || fallbackForwarding || typeof fallback.on !== 'function') return;
    fallbackForwarding = fallback.on('any', forward);
    if (typeof fallback.connect === 'function') {
      try {
        fallback.connect();
        fallbackConnected = true;
      } catch (error) {
        // A workspace-key client may have no stream at all; agent sources can
        // still arrive later, so surface the failure without giving up.
        report(error);
      }
    }
  };

  const detachFallback = (): void => {
    if (!fallbackForwarding) return;
    fallbackForwarding();
    fallbackForwarding = undefined;
    if (fallbackConnected) {
      fallbackConnected = false;
      try {
        void fallback?.disconnect().catch(() => {});
      } catch {
        // Fallback surfaces without a disconnect are simply left as-is.
      }
    }
  };

  return {
    addSource: (source) => {
      // A source without a subscribable stream (partial fakes injected via
      // `createAgentMessaging`) contributes nothing; skip it entirely.
      if (!source || typeof source.on !== 'function') return;
      if (seenSources.has(source)) return;
      seenSources.add(source);
      sources.push(source);
      source.on('any', forward);
      if (connectRequested) {
        connectSource(source);
        clearNoSourceTimer();
        // The agent transport is the real event stream; stop the workspace
        // fallback so it does not sit in a doomed reconnect loop.
        detachFallback();
      }
    },

    hasAgentSources: () => sources.length > 0,

    connect: () => {
      connectRequested = true;
      if (sources.length > 0) {
        for (const source of sources) connectSource(source);
        return;
      }
      attachFallback();
      scheduleNoSourceWarning();
    },

    disconnect: async () => {
      connectRequested = false;
      clearNoSourceTimer();
      detachFallback();
      await Promise.allSettled(sources.map((source) => Promise.resolve().then(() => source.disconnect())));
    },

    subscribe: (channels) => {
      for (const channel of channels) desiredChannels.add(channel);
      for (const source of sources) {
        try {
          source.subscribe(channels);
        } catch (error) {
          report(error);
        }
      }
    },

    unsubscribe: (channels) => {
      for (const channel of channels) desiredChannels.delete(channel);
      for (const source of sources) {
        try {
          source.unsubscribe(channels);
        } catch (error) {
          report(error);
        }
      }
    },

    on: <K extends keyof RelayMessagingEventMap>(
      event: K,
      handler: (...args: RelayMessagingEventMap[K]) => void | Promise<void>
    ): (() => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as (event: RelayMessagingEvent) => void | Promise<void>);
      handlers.set(event, set);
      return () => {
        set.delete(handler as (event: RelayMessagingEvent) => void | Promise<void>);
      };
    },
  };
}
