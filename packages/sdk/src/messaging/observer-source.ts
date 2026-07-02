import { RelayCast } from '@relaycast/sdk';

import { normalizeMessagingEvent } from './normalize.js';
import type { RelayMessagingEvent, RelayMessagingEventMap, RelayMessagingEventsSurface } from './types.js';

/**
 * The slice of the live observer stream the source depends on. A `RelayCast`
 * client constructed with an observer token satisfies it: `connect()` opens
 * `/v1/ws?token=<observer token>` and `on.any(...)` delivers the raw server
 * event frames.
 */
export interface ObserverLiveStream {
  connect(): void;
  disconnect(): void;
  on: { any(handler: (event: unknown) => void): () => void };
}

/**
 * Options for {@link createObserverEventSource}.
 */
export interface ObserverEventSourceOptions {
  /** Read-only observer token (`ot_live_...`) with `stream:read` scope. */
  observerToken: string;
  /** Relaycast base URL. Defaults to the hosted gateway. */
  baseUrl?: string;
  /**
   * Resume the durable event log after this per-workspace sequence number
   * (exclusive). Defaults to `0` (backfill from the start of the log).
   */
  sinceSeq?: number;
  /**
   * Receives every advanced cursor value. Persisting the cursor is the
   * caller's job: store the last value and pass it back as `sinceSeq` to
   * resume without gaps or duplicates.
   */
  onCursor?: (seq: number) => void;
  /** Receives live-stream and backfill failures. Defaults to console warnings. */
  onError?: (error: unknown) => void;
  /** Live stream factory override for tests. Defaults to a `RelayCast` client. */
  createLiveStream?: () => ObserverLiveStream;
  /** Fetch override for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** REST backfill page size. The server caps pages at 500 events. */
  backfillPageSize?: number;
}

const DEFAULT_BASE_URL = 'https://cast.agentrelay.com';
const MAX_BACKFILL_PAGE_SIZE = 500;

/** One raw event frame from the durable workspace event log. */
interface BackfillEventRow {
  seq: number;
  payload: unknown;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the per-workspace monotonic sequence number stamped on a live frame.
 * Frames without a `seq` were never appended to the durable log (server-side
 * append failure) and are treated as live-only.
 */
function readSeq(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const value = raw.seq;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseBackfillEvents(payload: unknown): { events: BackfillEventRow[]; latestSeq: number } {
  const record = isRecord(payload) ? payload : {};
  const data = isRecord(record.data) ? record.data : {};
  const rows = Array.isArray(data.events) ? data.events : [];
  const events: BackfillEventRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const seq = typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : undefined;
    if (seq === undefined) continue;
    events.push({ seq, payload: row.payload });
  }
  const latestSeq =
    typeof data.latest_seq === 'number' && Number.isFinite(data.latest_seq) ? data.latest_seq : 0;
  return { events, latestSeq };
}

/**
 * Create a {@link RelayMessagingEventsSurface} backed by the workspace
 * observer plane: the durable per-workspace event log plus the live
 * observer WebSocket stream.
 *
 * On `connect()` the source:
 *
 * 1. opens the live stream and buffers incoming frames,
 * 2. REST-backfills `GET /v1/workspace/events` from the in-memory cursor
 *    (starting at `sinceSeq`, default `0`), paginating until `latest_seq`,
 * 3. emits the backfilled events, then the buffered/live frames — deduped
 *    and ordered by `seq`. Frames without a `seq` pass straight through.
 *
 * When the backfill endpoint is missing (404 on older engines) or fails,
 * the source degrades to live-only streaming. Raw frames flow through
 * {@link normalizeMessagingEvent}, so listeners receive the same public event
 * shapes as every other source.
 *
 * @param options - Observer token, cursor, and injectable transports.
 * @returns An events surface suitable as an event fan-in source.
 */
export function createObserverEventSource(options: ObserverEventSourceOptions): RelayMessagingEventsSurface {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const pageSize = Math.min(
    Math.max(options.backfillPageSize ?? MAX_BACKFILL_PAGE_SIZE, 1),
    MAX_BACKFILL_PAGE_SIZE
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const createLiveStream =
    options.createLiveStream ??
    (() => new RelayCast({ apiKey: options.observerToken, baseUrl }) as unknown as ObserverLiveStream);

  const handlers = new Map<string, Set<(event: RelayMessagingEvent) => void | Promise<void>>>();

  /** Highest durable-log sequence emitted so far; events at or below it are duplicates. */
  let cursor = options.sinceSeq ?? 0;
  let live: ObserverLiveStream | undefined;
  let offLive: (() => void) | undefined;
  /** Raw live frames received while the backfill is still running, in arrival order. */
  let pending: unknown[] = [];
  let backfillDone = false;
  /** Invalidates in-flight backfills when the source is disconnected. */
  let epoch = 0;

  const report = (error: unknown): void => {
    if (options.onError) {
      try {
        options.onError(error);
      } catch {
        // Error hooks must not throw into the event source.
      }
      return;
    }
    console.warn('[agent-relay] observer stream:', error);
  };

  const emit = (event: RelayMessagingEvent): void => {
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

  const advanceCursor = (seq: number): void => {
    cursor = seq;
    if (options.onCursor) {
      try {
        options.onCursor(seq);
      } catch {
        // Cursor hooks must not throw into the event source.
      }
    }
  };

  /** Emit a raw frame, deduping seq-stamped frames against the cursor. */
  const deliver = (raw: unknown): void => {
    const seq = readSeq(raw);
    if (seq !== undefined) {
      if (seq <= cursor) return;
      advanceCursor(seq);
    }
    emit(normalizeMessagingEvent(raw));
  };

  const handleLiveFrame = (raw: unknown): void => {
    if (!backfillDone) {
      pending.push(raw);
      return;
    }
    deliver(raw);
  };

  /**
   * Flush frames buffered during the backfill. Seq-stamped frames are ordered
   * by `seq` among themselves (stable sort — frames without a `seq` keep their
   * arrival position) and deduped against the cursor; the rest pass through.
   */
  const flushPending = (): void => {
    backfillDone = true;
    const buffered = pending;
    pending = [];
    buffered.sort((a, b) => {
      const seqA = readSeq(a);
      const seqB = readSeq(b);
      return seqA !== undefined && seqB !== undefined ? seqA - seqB : 0;
    });
    for (const raw of buffered) deliver(raw);
  };

  const backfillPage = async (
    since: number
  ): Promise<{ events: BackfillEventRow[]; latestSeq: number } | undefined> => {
    const url = `${baseUrl}/v1/workspace/events?since=${since}&limit=${pageSize}`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${options.observerToken}` },
    });
    // Older engines have no durable event log; observer mode then works
    // live-only and the cursor advances from seq-stamped live frames.
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`observer backfill failed: HTTP ${response.status} for GET /v1/workspace/events`);
    }
    return parseBackfillEvents(await response.json());
  };

  const runBackfill = async (): Promise<void> => {
    const startedEpoch = epoch;
    try {
      for (;;) {
        const page = await backfillPage(cursor);
        if (epoch !== startedEpoch) return;
        if (!page || page.events.length === 0) break;
        for (const event of page.events) {
          if (event.seq <= cursor) continue;
          advanceCursor(event.seq);
          emit(normalizeMessagingEvent(event.payload));
        }
        if (cursor >= page.latestSeq) break;
      }
    } catch (error) {
      if (epoch !== startedEpoch) return;
      // Backfill is best-effort: degrade to live-only rather than losing the
      // stream entirely.
      report(error);
    }
    if (epoch !== startedEpoch) return;
    flushPending();
  };

  return {
    connect: (): void => {
      if (live) return;
      backfillDone = false;
      pending = [];
      try {
        live = createLiveStream();
        offLive = live.on.any(handleLiveFrame);
        live.connect();
      } catch (error) {
        report(error);
        // With no live stream, backfilled events are all we can deliver;
        // don't hold them hostage in the buffer.
      }
      void runBackfill();
    },

    disconnect: async (): Promise<void> => {
      epoch += 1;
      backfillDone = false;
      pending = [];
      offLive?.();
      offLive = undefined;
      const stream = live;
      live = undefined;
      if (stream) {
        try {
          stream.disconnect();
        } catch (error) {
          report(error);
        }
      }
    },

    // The observer stream is workspace-wide; there is no per-channel
    // subscription surface on the observer socket.
    subscribe: (): void => {},
    unsubscribe: (): void => {},

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
