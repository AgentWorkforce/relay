import { normalizeMessagingEvent } from './normalize.js';
import type { RelayMessagingEvent, RelayMessagingEventMap, RelayMessagingEventsSurface } from './types.js';

/**
 * The slice of the live observer stream the source depends on. The default
 * implementation is a raw WebSocket to `/v1/ws` (bearer-authenticated) that
 * delivers each JSON frame untouched — the frames must arrive raw because the
 * durable-log cursor rides on their top-level `seq` field, which higher-level
 * clients strip during schema parsing.
 */
export interface ObserverLiveStream {
  connect(): void;
  disconnect(): void;
  on: {
    any(handler: (event: unknown) => void): () => void;
    /** Fires on every socket (re)open; used to re-backfill after a reconnect. */
    open?(handler: () => void): () => void;
  };
}

/**
 * Strip trailing `/` characters in linear time. A regex like `/\/+$/` is a
 * polynomial-ReDoS hazard on attacker-influenced strings (CodeQL flags it), so
 * we walk the tail explicitly instead.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return value.slice(0, end);
}

/**
 * Build the observer stream URL. The scheme is always `wss:` except for
 * loopback hosts (local self-hosted engines), and the URL never carries the
 * token — authentication travels in the `Authorization` header where the
 * runtime supports it, with an explicit query-token downgrade only when it
 * does not (see {@link createRawObserverStream}).
 */
function observerWsUrl(baseUrl: string, opts: { includeToken?: string } = {}): string {
  const url = new URL(baseUrl);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  url.protocol = url.protocol === 'http:' && loopback ? 'ws:' : 'wss:';
  url.pathname = `${stripTrailingSlashes(url.pathname)}/v1/ws`;
  if (opts.includeToken !== undefined) {
    url.searchParams.set('token', opts.includeToken);
  }
  return url.toString();
}

/**
 * Whether the current runtime is Node.js. Node's `undici` WebSocket accepts an
 * `Authorization` header via its constructor-options extension, so Node never
 * needs to fall back to the token-in-URL convention — keeping the token out of
 * request lines and access logs.
 */
function isNodeRuntime(): boolean {
  return typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;
}

/**
 * Raw observer WebSocket with capped-backoff auto-reconnect. Uses the global
 * `WebSocket` (Node >= 22, all browsers), or an injected implementation for
 * runtimes without one (e.g. Node < 22 with the `ws` package). Frames are
 * parsed as JSON and handed to `on.any` handlers verbatim, preserving the
 * top-level `seq`.
 *
 * Authentication: the token is sent as an `Authorization: Bearer` header via
 * the Node (undici) constructor options extension, keeping it out of the URL.
 * Only browser-like runtimes, whose `WebSocket` rejects or silently ignores
 * constructor options per the WHATWG signature, fall back to the server's
 * `?token=` query convention — and only after the constructor throws or two
 * consecutive header attempts close before ever opening, so a single transient
 * network blip on Node can never trigger a persistent token-in-URL downgrade.
 */
function createRawObserverStream(
  baseUrl: string,
  token: string,
  report: (error: unknown) => void,
  webSocketImpl?: typeof WebSocket
): ObserverLiveStream {
  const anyHandlers = new Set<(event: unknown) => void>();
  const openHandlers = new Set<() => void>();
  const nodeRuntime = isNodeRuntime();
  let socket: WebSocket | undefined;
  let closed = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether header auth has been observed working (any successful open). */
  let everOpened = false;
  /** Downgrade flag: the runtime cannot send headers, use the query token. */
  let useQueryToken = false;
  /** Consecutive header-auth attempts that closed before opening (browser probe). */
  let headerCloseStreak = 0;

  const scheduleReconnect = (delayOverrideMs?: number): void => {
    if (closed || timer !== undefined) return;
    attempts += 1;
    const delay = delayOverrideMs ?? Math.min(30_000, 1_000 * 2 ** Math.min(attempts - 1, 5));
    timer = setTimeout(() => {
      timer = undefined;
      open();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  };

  const construct = (WebSocketImpl: typeof WebSocket): WebSocket => {
    if (useQueryToken) {
      return new WebSocketImpl(observerWsUrl(baseUrl, { includeToken: token }));
    }
    try {
      // Node's undici WebSocket accepts { headers } as a non-standard
      // extension; browsers throw on a non-protocols second argument.
      return new (WebSocketImpl as new (url: string, options: unknown) => WebSocket)(observerWsUrl(baseUrl), {
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {
      useQueryToken = true;
      return new WebSocketImpl(observerWsUrl(baseUrl, { includeToken: token }));
    }
  };

  const open = (): void => {
    if (closed || socket) return;
    const WebSocketImpl = webSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WebSocketImpl) {
      report(
        new Error(
          'No WebSocket implementation available for the observer stream. Node exposes a ' +
            'global `WebSocket` only from v22; on earlier supported runtimes (Node >= 20.9) ' +
            'install one as `globalThis.WebSocket` (e.g. the `ws` package) or pass ' +
            '`webSocketImpl`/`createLiveStream` to observer mode.'
        )
      );
      return;
    }
    let ws: WebSocket;
    try {
      ws = construct(WebSocketImpl);
    } catch (error) {
      report(error);
      scheduleReconnect();
      return;
    }
    let openedHere = false;
    socket = ws;
    ws.onopen = () => {
      attempts = 0;
      everOpened = true;
      openedHere = true;
      headerCloseStreak = 0;
      for (const handler of openHandlers) handler();
    };
    ws.onmessage = (message: MessageEvent) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return; // Non-JSON frames carry nothing for us.
      }
      for (const handler of anyHandlers) handler(frame);
    };
    ws.onclose = (event?: { code?: number; reason?: string; wasClean?: boolean }) => {
      if (socket === ws) socket = undefined;
      if (closed) return; // Intentional teardown owns its own cleanup.
      // A close before the first successful open on a header-auth attempt can
      // mean the runtime accepted the options object but ignored the headers
      // (browsers). Only browser-like runtimes downgrade to the query token,
      // and only after two such probe closes — a Node runtime keeps header
      // auth (and never leaks the token into the URL) even across transient
      // failures.
      if (!useQueryToken && !everOpened && !openedHere) {
        if (!nodeRuntime) {
          headerCloseStreak += 1;
          if (headerCloseStreak >= 2) {
            useQueryToken = true;
            scheduleReconnect(0);
            return;
          }
          scheduleReconnect(0);
          return;
        }
      }
      // Surface abnormal closures so invalid tokens / server rejections are not
      // hidden behind a silent reconnect loop; clean closes (code 1000) stay quiet.
      const code = event?.code;
      const clean = event?.wasClean === true || code === 1000;
      if (!clean) {
        report(
          new Error(
            `observer WebSocket closed unexpectedly${
              code !== undefined ? ` (code ${code}${event?.reason ? `: ${event.reason}` : ''})` : ''
            }`
          )
        );
      }
      scheduleReconnect();
    };
    ws.onerror = () => {
      // Abnormal closures are reported in onclose; onerror carries no extra detail.
    };
  };

  return {
    connect: open,
    disconnect: () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const ws = socket;
      socket = undefined;
      try {
        ws?.close();
      } catch {
        // Already closed.
      }
    },
    on: {
      any: (handler) => {
        anyHandlers.add(handler);
        return () => anyHandlers.delete(handler);
      },
      open: (handler) => {
        openHandlers.add(handler);
        return () => openHandlers.delete(handler);
      },
    },
  };
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
  /** Live stream factory override for tests. Defaults to a raw observer WebSocket. */
  createLiveStream?: () => ObserverLiveStream;
  /**
   * WebSocket implementation for the default live stream. Defaults to
   * `globalThis.WebSocket`. Supply this (or a global polyfill such as the `ws`
   * package) on runtimes without a native `WebSocket` (e.g. Node < 22).
   */
  webSocketImpl?: typeof WebSocket;
  /** Fetch override for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** REST backfill page size. The server caps pages at 500 events. */
  backfillPageSize?: number;
  /**
   * Per-request timeout for each backfill page fetch, in milliseconds. A stalled
   * backfill would otherwise buffer live frames indefinitely; on timeout the
   * source degrades to live-only. Defaults to 30s.
   */
  backfillTimeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://cast.agentrelay.com';
const MAX_BACKFILL_PAGE_SIZE = 500;
const DEFAULT_BACKFILL_TIMEOUT_MS = 30_000;

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

function parseBackfillEvents(payload: unknown): {
  events: BackfillEventRow[];
  latestSeq: number;
  nextSince: number | undefined;
} {
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
  // Scoped-token resume cursor: the seq of the last row the server's scan
  // consumed (visible or filtered). Absent on older engines.
  const nextSince =
    typeof data.next_since === 'number' && Number.isFinite(data.next_since) ? data.next_since : undefined;
  return { events, latestSeq, nextSince };
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
  const baseUrl = stripTrailingSlashes(options.baseUrl ?? DEFAULT_BASE_URL);
  const pageSize = Math.min(
    Math.max(options.backfillPageSize ?? MAX_BACKFILL_PAGE_SIZE, 1),
    MAX_BACKFILL_PAGE_SIZE
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const backfillTimeoutMs = options.backfillTimeoutMs ?? DEFAULT_BACKFILL_TIMEOUT_MS;
  const createLiveStream =
    options.createLiveStream ??
    (() => createRawObserverStream(baseUrl, options.observerToken, report, options.webSocketImpl));

  const handlers = new Map<string, Set<(event: RelayMessagingEvent) => void | Promise<void>>>();

  /** Highest durable-log sequence emitted so far; events at or below it are duplicates. */
  let cursor = options.sinceSeq ?? 0;
  let live: ObserverLiveStream | undefined;
  let offLive: (() => void) | undefined;
  let offOpen: (() => void) | undefined;
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
    // Order seq-stamped frames among themselves; seq-less frames keep their
    // arrival slot. Sorting the whole array with a comparator that returns 0
    // for any pair involving a seq-less frame is not a total order (a higher
    // seq could sort ahead of a lower one across a seq-less gap and advance the
    // cursor past it), so we sort the sequenced frames out-of-band and splice
    // them back into the seq-less skeleton.
    const sequenced = buffered
      .map((raw) => ({ raw, seq: readSeq(raw) }))
      .filter((item): item is { raw: unknown; seq: number } => item.seq !== undefined)
      .sort((a, b) => a.seq - b.seq);
    let nextSequenced = 0;
    for (const raw of buffered) {
      deliver(readSeq(raw) === undefined ? raw : sequenced[nextSequenced++].raw);
    }
  };

  const backfillPage = async (
    since: number
  ): Promise<
    { events: BackfillEventRow[]; latestSeq: number; nextSince: number | undefined } | undefined
  > => {
    const url = `${baseUrl}/v1/workspace/events?since=${since}&limit=${pageSize}`;
    // Bound each page fetch so a hung backfill endpoint can't buffer live frames
    // forever; on timeout the caller degrades to live-only.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), backfillTimeoutMs);
    (timeout as { unref?: () => void }).unref?.();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${options.observerToken}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
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
        const before = cursor;
        const page = await backfillPage(cursor);
        if (epoch !== startedEpoch) return;
        if (!page) break;
        for (const event of page.events) {
          if (event.seq <= cursor) continue;
          advanceCursor(event.seq);
          emit(normalizeMessagingEvent(event.payload));
        }
        // For scoped observer tokens a page can be empty while hidden rows
        // were consumed server-side; `next_since` advances the cursor past
        // them (events hidden from this token will never be delivered live
        // either, so skipping their seqs is safe).
        if (page.nextSince !== undefined && page.nextSince > cursor) {
          advanceCursor(page.nextSince);
        }
        if (cursor >= page.latestSeq) break;
        // No progress this page (older engine without next_since returning
        // only hidden rows): stop rather than loop forever, but surface it —
        // historical events after this point may never be backfilled.
        if (cursor <= before) {
          report(
            new Error(
              `observer backfill stopped early: engine returned no visible events and no next_since ` +
                `cursor at seq ${cursor} (latest ${page.latestSeq}); historical events past this ` +
                `point may be skipped. Upgrade the engine for next_since-based scoped backfill.`
            )
          );
          break;
        }
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
        // Frames missed while the socket was down are only in the durable
        // log: on every reopen after the first, buffer live frames again and
        // re-backfill from the cursor to close the gap.
        let hadOpen = false;
        offOpen = live.on.open?.(() => {
          if (hadOpen) {
            backfillDone = false;
            void runBackfill();
          }
          hadOpen = true;
        });
        live.connect();
      } catch (error) {
        // A partially initialized stream would make later connect() calls
        // return early (live is set) and never retry. Tear it down so a fresh
        // stream can be built on the next connect().
        offLive?.();
        offLive = undefined;
        offOpen?.();
        offOpen = undefined;
        const stream = live;
        live = undefined;
        try {
          stream?.disconnect();
        } catch {
          // Best-effort cleanup after a failed live-stream initialization.
        }
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
      offOpen?.();
      offOpen = undefined;
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
