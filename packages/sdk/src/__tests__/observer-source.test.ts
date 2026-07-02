import { afterEach, describe, expect, it, vi } from 'vitest';

const relaycastMocks = vi.hoisted(() => {
  const relayCast = vi.fn();
  return { relayCast };
});

vi.mock('@relaycast/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relaycast/sdk')>();
  return { ...actual, RelayCast: relaycastMocks.relayCast };
});

import { AgentRelay } from '../index.js';
import { createObserverEventSource, type ObserverLiveStream } from '../messaging/observer-source.js';
import type { RelayMessaging, RelayMessagingEvent } from '../messaging/index.js';

function createFakeLiveStream() {
  const handlers = new Set<(event: unknown) => void>();
  const stream: ObserverLiveStream & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  } = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: {
      any: (handler: (event: unknown) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  };
  return {
    stream,
    emit: (event: unknown) => {
      for (const handler of [...handlers]) handler(event);
    },
  };
}

/** Raw server frame as the live observer WS delivers it. */
function liveFrame(messageId: string, seq?: number): Record<string, unknown> {
  return {
    type: 'message.created',
    channel: 'general',
    message: { id: messageId, text: `text-${messageId}` },
    ...(seq !== undefined ? { seq } : {}),
  };
}

/** Durable event-log row as GET /v1/workspace/events returns it. */
function logRow(seq: number, messageId: string): Record<string, unknown> {
  return {
    seq,
    type: 'message.created',
    channel_id: 'c1',
    payload: liveFrame(messageId),
    created_at: '2026-07-02T00:00:00Z',
  };
}

function jsonResponse(events: Record<string, unknown>[], latestSeq: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: { events, latest_seq: latestSeq } }),
  } as Response;
}

function notFoundResponse() {
  return { ok: false, status: 404, json: async () => ({ ok: false }) } as Response;
}

/** Serve pages of the given log rows keyed off the `since` query parameter. */
function createBackfillFetch(rows: Record<string, unknown>[], latestSeq?: number) {
  const latest = latestSeq ?? (rows.length > 0 ? (rows[rows.length - 1].seq as number) : 0);
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const since = Number(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '500');
    const page = rows.filter((row) => (row.seq as number) > since).slice(0, limit);
    return jsonResponse(page, latest);
  }) as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  // Let the async backfill loop (fetch + json awaits) run to completion.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function collect(source: ReturnType<typeof createObserverEventSource>) {
  const received: RelayMessagingEvent[] = [];
  source.on('any', (event) => {
    received.push(event);
  });
  return received;
}

function messageIds(events: RelayMessagingEvent[]): string[] {
  return events
    .filter((event) => event.type === 'messageCreated')
    .map((event) => (event as Extract<RelayMessagingEvent, { type: 'messageCreated' }>).message.messageId);
}

afterEach(() => {
  relaycastMocks.relayCast.mockReset();
  vi.unstubAllGlobals();
});

describe('createObserverEventSource', () => {
  it('backfills from the log, then merges buffered live frames deduped and ordered by seq', async () => {
    const live = createFakeLiveStream();
    let releaseBackfill!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBackfill = resolve;
    });
    const rows = [logRow(1, 'm1'), logRow(2, 'm2'), logRow(3, 'm3')];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      await gate;
      const url = new URL(String(input));
      const since = Number(url.searchParams.get('since') ?? '0');
      return jsonResponse(
        rows.filter((row) => (row.seq as number) > since),
        3
      );
    }) as unknown as typeof fetch;

    const cursors: number[] = [];
    const source = createObserverEventSource({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
      onCursor: (seq) => cursors.push(seq),
    });
    const received = collect(source);

    source.connect();
    expect(live.stream.connect).toHaveBeenCalledTimes(1);

    // Live frames arrive while the backfill is in flight: seq 4/3 buffered
    // out of order, seq 3 is also covered by the backfill.
    live.emit(liveFrame('m4', 4));
    live.emit(liveFrame('m3', 3));
    expect(received).toHaveLength(0);

    releaseBackfill();
    await settle();

    expect(messageIds(received)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(cursors).toEqual([1, 2, 3, 4]);
  });

  it('paginates the backfill until latest_seq', async () => {
    const live = createFakeLiveStream();
    const rows = [logRow(1, 'm1'), logRow(2, 'm2'), logRow(3, 'm3'), logRow(4, 'm4')];
    const fetchImpl = createBackfillFetch(rows);

    const source = createObserverEventSource({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
      backfillPageSize: 2,
    });
    const received = collect(source);

    source.connect();
    await settle();

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0])
    );
    expect(calls).toEqual([
      'https://api.example.test/v1/workspace/events?since=0&limit=2',
      'https://api.example.test/v1/workspace/events?since=2&limit=2',
    ]);
    expect(messageIds(received)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('resumes from sinceSeq and skips already-seen events', async () => {
    const live = createFakeLiveStream();
    const rows = [logRow(3, 'm3'), logRow(4, 'm4')];
    const fetchImpl = createBackfillFetch(rows, 4);

    const source = createObserverEventSource({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
      sinceSeq: 2,
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
    });
    const received = collect(source);

    source.connect();
    await settle();

    const firstUrl = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(firstUrl).toContain('since=2');
    expect(messageIds(received)).toEqual(['m3', 'm4']);
  });

  it('dedupes live frames at or below the cursor and passes seq-less frames through', async () => {
    const live = createFakeLiveStream();
    const fetchImpl = createBackfillFetch([logRow(1, 'm1'), logRow(2, 'm2')]);

    const source = createObserverEventSource({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
    });
    const received = collect(source);

    source.connect();
    await settle();

    live.emit(liveFrame('m2', 2)); // duplicate of a backfilled event
    live.emit(liveFrame('m3', 3));
    live.emit(liveFrame('m3', 3)); // duplicate live redelivery
    live.emit(liveFrame('m-live-only')); // log append failed: no seq, live-only
    live.emit({ type: 'open' }); // transport frames have no seq

    expect(messageIds(received)).toEqual(['m1', 'm2', 'm3', 'm-live-only']);
    expect(received.some((event) => event.type === 'connected')).toBe(true);
  });

  it('sends the observer token as a bearer on backfill requests', async () => {
    const live = createFakeLiveStream();
    const fetchImpl = createBackfillFetch([]);

    createObserverEventSource({
      observerToken: 'ot_live_secret',
      baseUrl: 'https://api.example.test',
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
    }).connect();
    await settle();

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ Authorization: 'Bearer ot_live_secret' });
  });

  it('degrades to live-only when the backfill endpoint 404s', async () => {
    const live = createFakeLiveStream();
    const fetchImpl = vi.fn(async () => notFoundResponse()) as unknown as typeof fetch;
    const onError = vi.fn();
    const cursors: number[] = [];

    const source = createObserverEventSource({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
      onError,
      onCursor: (seq) => cursors.push(seq),
    });
    const received = collect(source);

    source.connect();
    live.emit(liveFrame('m1', 1)); // buffered until the 404 resolves
    await settle();
    live.emit(liveFrame('m2', 2));

    expect(messageIds(received)).toEqual(['m1', 'm2']);
    // A missing endpoint is expected on older engines, not an error.
    expect(onError).not.toHaveBeenCalled();
    // The cursor still tracks live seq so callers can persist it.
    expect(cursors).toEqual([1, 2]);
  });

  it('reports backfill failures and still delivers the live stream', async () => {
    const live = createFakeLiveStream();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const onError = vi.fn();

    const source = createObserverEventSource({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
      onError,
    });
    const received = collect(source);

    source.connect();
    await settle();
    live.emit(liveFrame('m1', 1));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(messageIds(received)).toEqual(['m1']);
  });

  it('disconnect stops the live stream; reconnect backfills from the cursor', async () => {
    const live = createFakeLiveStream();
    const fetchImpl = createBackfillFetch([logRow(1, 'm1'), logRow(2, 'm2')]);

    const source = createObserverEventSource({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
      createLiveStream: () => live.stream,
      fetch: fetchImpl,
    });
    const received = collect(source);

    source.connect();
    await settle();
    await source.disconnect();
    expect(live.stream.disconnect).toHaveBeenCalledTimes(1);

    live.emit(liveFrame('m-late', 3)); // detached: must not emit
    expect(messageIds(received)).toEqual(['m1', 'm2']);

    source.connect();
    await settle();
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0])
    );
    expect(calls[calls.length - 1]).toContain('since=2');
  });
});

describe('AgentRelay observer mode', () => {
  function createObserverRelay(overrides: Record<string, unknown> = {}) {
    // A partial messaging fake: observer mode never uses the workspace
    // client's event stream and register/reconnect throw at the facade.
    const messaging = {
      workspace: { info: vi.fn(async () => ({})), fleetNodes: {} },
      agents: {},
      events: undefined,
    } as unknown as RelayMessaging;
    return new AgentRelay({ observerToken: 'ot_live_test', messaging, ...overrides });
  }

  it('workspace.register() throws a read-only error', async () => {
    const relay = createObserverRelay();
    await expect(async () => relay.workspace.register('Reviewer')).rejects.toThrow(
      /observer tokens are read-only; use a workspace key to register agents/
    );
  });

  it('workspace.reconnect() throws a read-only error', async () => {
    const relay = createObserverRelay();
    await expect(relay.workspace.reconnect({ apiToken: 'rat_test' })).rejects.toThrow(
      /observer tokens are read-only; use a workspace key to register agents/
    );
  });

  it('streams observer events through relay.addListener', async () => {
    const live = createFakeLiveStream();
    relaycastMocks.relayCast.mockImplementation(function () {
      return live.stream;
    });
    vi.stubGlobal('fetch', createBackfillFetch([logRow(1, 'm1')]));

    const relay = new AgentRelay({
      observerToken: 'ot_live_test',
      baseUrl: 'https://api.example.test',
    });

    const received: unknown[] = [];
    relay.addListener('message.created', (event) => {
      received.push(event);
    });
    await settle();
    live.emit(liveFrame('m2', 2));

    expect(relaycastMocks.relayCast).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'ot_live_test', baseUrl: 'https://api.example.test' })
    );
    expect(received).toHaveLength(2);
  });
});
