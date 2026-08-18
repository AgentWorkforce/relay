/**
 * Delivery-mode PUT lifecycle tests for the fleet-node loopback attach
 * adapter. These stand up a real local WebSocketServer to play the role of
 * the remote Relaycast terminal endpoint, and drive the real loopback HTTP
 * server the adapter starts (via Node's built-in fetch), so the behaviour
 * under test is the actual runtime wiring rather than a mocked stand-in.
 */
import type { AddressInfo } from 'node:net';

import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startFleetNodeAttachProxy, type FleetNodeAttachProxy } from './attach-fleet-node.js';

const SESSION_ID = 'session-under-test';
const RESUME_TOKEN = 'resume-token';

type FakeRemoteHandle = {
  wss: WebSocketServer;
  url: string;
  /** Resolves with the first socket that connects. */
  nextConnection: () => Promise<WsSocket>;
  close: () => Promise<void>;
};

async function startFakeRemote(upgradeDelayMs = 0): Promise<FakeRemoteHandle> {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    ...(upgradeDelayMs > 0
      ? {
          verifyClient: (_info, done) => {
            setTimeout(() => done(true), upgradeDelayMs);
          },
        }
      : {}),
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  const connections: WsSocket[] = [];
  const waiters: Array<(socket: WsSocket) => void> = [];
  wss.on('connection', (socket) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(socket);
    } else {
      connections.push(socket);
    }
  });
  return {
    wss,
    url: `ws://127.0.0.1:${port}/terminal`,
    nextConnection: () =>
      new Promise<WsSocket>((resolve) => {
        const existing = connections.shift();
        if (existing) {
          resolve(existing);
          return;
        }
        waiters.push(resolve);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of connections) socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

function fakeTicketFetch(remoteUrl: string): typeof globalThis.fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          session_id: SESSION_ID,
          terminal_url: `${remoteUrl}?ticket=abc`,
          resume_token: RESUME_TOKEN,
        },
      }),
    }) as unknown as Response) as unknown as typeof globalThis.fetch;
}

function terminalSessionErrorResponse(code: string, message: string, status = 503): Response {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, error: { code, message } }),
  } as unknown as Response;
}

function sendReady(socket: WsSocket, deliveryMode?: 'auto_inject' | 'manual_flush'): void {
  socket.send(
    JSON.stringify({
      type: 'terminal.ready',
      session_id: SESSION_ID,
      screen: '',
      rows: 24,
      cols: 80,
      offset: 0,
      ...(deliveryMode ? { delivery_mode: deliveryMode } : {}),
    })
  );
}

async function putDeliveryMode(
  proxy: FleetNodeAttachProxy,
  agent: string,
  mode: 'auto_inject' | 'manual_flush'
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${proxy.brokerUrl}/api/spawned/${encodeURIComponent(agent)}/delivery-mode`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${proxy.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

async function connectLoopbackEvents(proxy: FleetNodeAttachProxy): Promise<WsClient> {
  const socket = new WsClient(`${proxy.brokerUrl.replace(/^http/, 'ws')}/ws`, {
    headers: { Authorization: `Bearer ${proxy.apiKey}` },
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

describe('startFleetNodeAttachProxy terminal-session request retries', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanup.length > 0) {
      const fn = cleanup.pop()!;
      await fn().catch(() => undefined);
    }
  });

  // MUST FIRE: before relay#1571 the first 503 escaped directly and this
  // never reached the successful second response.
  it('retries a transient node_unreachable response before opening the terminal', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const success = fakeTicketFetch(remote.url);
    let calls = 0;
    const retryDelays: number[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return terminalSessionErrorResponse('node_unreachable', "Node 'node-transient' is not reachable");
      }
      return success(input, init);
    }) as typeof globalThis.fetch;

    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-transient',
      node: 'node-transient',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fetchFn,
      sessionRequest: {
        sleep: async (ms) => {
          retryDelays.push(ms);
        },
      },
    });
    cleanup.push(proxy.close);

    expect(calls).toBe(2);
    expect(retryDelays).toEqual([6_000]);
    const socket = await remote.nextConnection();
    sendReady(socket);
  });

  // MUST FIRE: the earlier 5s and 12s client deadlines both aborted live
  // control-plane requests under load. A response just inside the repository's
  // standard 30s Relay HTTP window must not be cut off by this caller.
  it('keeps the default terminal-session request alive through the bounded 30s window', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    let aborted = false;
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const responseTimer = setTimeout(() => {
          resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              data: {
                session_id: SESSION_ID,
                terminal_url: `${remote.url}?ticket=abc`,
                resume_token: RESUME_TOKEN,
              },
            }),
          } as Response);
        }, 29_000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            clearTimeout(responseTimer);
            reject(new Error('request aborted'));
          },
          { once: true }
        );
      })) as typeof globalThis.fetch;

    vi.useFakeTimers();
    const proxyPromise = startFleetNodeAttachProxy({
      agent: 'agent-slow-healthy',
      node: 'node-slow-healthy',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fetchFn,
    });
    void proxyPromise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(29_000);
    vi.useRealTimers();
    const proxy = await proxyPromise;
    cleanup.push(proxy.close);

    expect(aborted).toBe(false);
    const socket = await remote.nextConnection();
    sendReady(socket);
  });

  // MUST FIRE: five slow responses plus all retry delays would otherwise keep
  // this interactive command pending for roughly three minutes. The aggregate
  // deadline must abort the in-flight third request at exactly 90s.
  it('caps slow terminal-session retries with the 90s overall request budget', async () => {
    let calls = 0;
    let aborts = 0;
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        calls += 1;
        const responseTimer = setTimeout(() => {
          resolve(terminalSessionErrorResponse('node_unreachable', "Node 'node-slow-dead' is not reachable"));
        }, 29_000);
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborts += 1;
            clearTimeout(responseTimer);
            reject(new Error('request aborted'));
          },
          { once: true }
        );
      })) as typeof globalThis.fetch;

    vi.useFakeTimers();
    let settled = false;
    const rejectedPromise = startFleetNodeAttachProxy({
      agent: 'agent-slow-dead',
      node: 'node-slow-dead',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fetchFn,
    }).catch((error: unknown) => error);
    void rejectedPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(89_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const rejected = await rejectedPromise;
    vi.useRealTimers();

    expect(calls).toBe(3);
    expect(aborts).toBe(1);
    expect(rejected).toMatchObject({ code: 'control_plane_timeout' });
    expect((rejected as Error).message).toContain('overall budget 90000ms');
    expect((rejected as Error).message).toContain(
      'attempts 3 (retried 2 times; final POST not retried because it may have completed server-side)'
    );
  });

  // MUST NOT FIRE: exhausting the bounded retry budget must remain a hard,
  // diagnostic failure rather than opening a false-success proxy or looping.
  it('still fails a genuinely unreachable node after the bounded attempts', async () => {
    let calls = 0;
    const retryDelays: number[] = [];
    const fetchFn = (async () => {
      calls += 1;
      return terminalSessionErrorResponse('node_unreachable', "Node 'node-dead' is not reachable");
    }) as typeof globalThis.fetch;

    const rejected = await startFleetNodeAttachProxy({
      agent: 'agent-dead',
      node: 'node-dead',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fetchFn,
      sessionRequest: {
        sleep: async (ms) => {
          retryDelays.push(ms);
        },
      },
    }).catch((error: unknown) => error);

    expect(calls).toBe(5);
    expect(retryDelays).toEqual([6_000, 7_200, 8_400, 9_600]);
    expect(retryDelays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(30_000);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected).toMatchObject({ code: 'node_unreachable' });
    expect((rejected as Error).message).toContain('control plane classified the node as unreachable');
    expect((rejected as Error).message).toContain('resolved node id unavailable');
    expect((rejected as Error).message).toContain('attempts 5 (retried 4 times)');
    expect((rejected as Error).message).toContain(
      'endpoint "https://fake.example/v1/nodes/node-dead/terminal/sessions"'
    );
  });

  it('does not retry a missing node record and labels the lookup failure', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return terminalSessionErrorResponse('node_not_found', 'Node not found', 404);
    }) as typeof globalThis.fetch;

    const rejected = await startFleetNodeAttachProxy({
      agent: 'agent-missing-node',
      node: 'node-missing',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fetchFn,
      sessionRequest: { sleep: async () => undefined },
    }).catch((error: unknown) => error);

    expect(calls).toBe(1);
    expect((rejected as Error).message).toContain('Control-plane node lookup found no matching record');
    expect((rejected as Error).message).toContain(
      'attempts 1 (not retried because the failure was terminal)'
    );
  });

  it('does not retry an unconfirmed POST after a control-plane network failure', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      throw new TypeError('socket closed before a response arrived');
    }) as typeof globalThis.fetch;

    const rejected = await startFleetNodeAttachProxy({
      agent: 'agent-unknown-completion',
      node: 'node-unknown-completion',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fetchFn,
      sessionRequest: { sleep: async () => undefined },
    }).catch((error: unknown) => error);

    expect(calls).toBe(1);
    expect((rejected as Error).message).toContain('Control-plane terminal-session lookup failed');
    expect((rejected as Error).message).toContain(
      'attempts 1 (not retried because the POST may have completed server-side)'
    );
  });

  it('normalizes a non-object JSON response without retaining a prior retryable error', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) {
        return terminalSessionErrorResponse('node_unreachable', "Node 'node-malformed' is not reachable");
      }
      return { ok: false, status: 502, json: async () => null } as unknown as Response;
    }) as typeof globalThis.fetch;

    const rejected = await startFleetNodeAttachProxy({
      agent: 'agent-malformed',
      node: 'node-malformed',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fetchFn,
      sessionRequest: { sleep: async () => undefined },
    }).catch((error: unknown) => error);

    expect(calls).toBe(2);
    expect(rejected).toMatchObject({ code: undefined });
    expect((rejected as Error).message).toContain('terminal session request failed (HTTP 502)');
    expect((rejected as Error).message).toContain('attempts 2 (retried 1 time)');
    expect((rejected as Error).message).not.toContain('classified the node as unreachable');
  });
});

describe('startFleetNodeAttachProxy delivery-mode PUT lifecycle', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop()!;
      await fn().catch(() => undefined);
    }
  });

  it('resolves the PUT once the remote replies with terminal.delivery_mode', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-a',
      node: 'node-a',
      mode: 'drive',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    const socket = await remote.nextConnection();
    sendReady(socket, 'auto_inject');
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (frame.type === 'terminal.set_delivery_mode') {
        socket.send(
          JSON.stringify({
            type: 'terminal.delivery_mode',
            session_id: SESSION_ID,
            request_id: frame.request_id,
            mode: frame.mode,
            flushed: 0,
            matched: true,
            revision: '2',
          })
        );
      }
    });

    const result = await putDeliveryMode(proxy, 'agent-a', 'manual_flush');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ mode: 'manual_flush', matched: true, revision: '2' });
  });

  it('waits for terminal.ready before forwarding the drive delivery-mode PUT', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-readiness',
      node: 'node-readiness',
      mode: 'drive',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    const socket = await remote.nextConnection();
    const receivedFrames: Array<Record<string, unknown>> = [];
    let readySent = false;
    /**
     * Ordering, not timing: flips if any frame is forwarded before
     * `terminal.ready` was sent, no matter how late the scheduler delivers it.
     * A regression that drops the readiness gate cannot slip past this by
     * emitting after some fixed observation window.
     */
    let forwardedBeforeReady = false;
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      receivedFrames.push(frame);
      if (!readySent) forwardedBeforeReady = true;
      if (frame.type === 'terminal.set_delivery_mode') {
        socket.send(
          JSON.stringify({
            type: 'terminal.delivery_mode',
            session_id: SESSION_ID,
            request_id: frame.request_id,
            mode: frame.mode,
            flushed: 0,
            matched: true,
            revision: '2',
          })
        );
      }
    });

    const resultPromise = putDeliveryMode(proxy, 'agent-readiness', 'auto_inject');
    // Race a sentinel against the PUT rather than asserting an absence after a
    // fixed sleep: the assertion is "still unresolved", which a regression that
    // answers the PUT at any point before `sendReady` cannot satisfy. The
    // 100ms is only the backstop that gives such a regression time to happen.
    const stillPending = Symbol('still-pending');
    const raced = await Promise.race([
      resultPromise,
      new Promise<symbol>((resolve) => setTimeout(() => resolve(stillPending), 100)),
    ]);
    expect(raced).toBe(stillPending);
    expect(receivedFrames).toEqual([]);

    readySent = true;
    sendReady(socket, 'manual_flush');
    await expect(resultPromise).resolves.toMatchObject({
      status: 200,
      body: { mode: 'auto_inject', matched: true },
    });
    expect(receivedFrames).toHaveLength(1);
    expect(forwardedBeforeReady).toBe(false);
  });

  it(
    'rejects a pending delivery-mode PUT promptly when terminal.closed arrives instead of a reply ' +
      '(endTerminal must reject pendingDeliveryMode, not leave it to time out)',
    async () => {
      const remote = await startFakeRemote();
      cleanup.push(remote.close);
      const proxy = await startFleetNodeAttachProxy({
        agent: 'agent-b',
        node: 'node-b',
        mode: 'drive',
        baseUrl: 'https://fake.example',
        workspaceKey: 'wk',
        fetch: fakeTicketFetch(remote.url),
      });
      cleanup.push(proxy.close);

      const socket = await remote.nextConnection();
      sendReady(socket, 'auto_inject');
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (frame.type === 'terminal.set_delivery_mode') {
          // Simulate the worker/session ending while the PUT is in flight,
          // instead of replying to the delivery-mode request at all.
          socket.send(JSON.stringify({ type: 'terminal.closed', session_id: SESSION_ID }));
        }
      });

      const started = Date.now();
      const result = await putDeliveryMode(proxy, 'agent-b', 'manual_flush');
      const elapsedMs = Date.now() - started;

      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ error: { code: 'terminal_closed' } });
      // The 10s DELIVERY_MODE_TIMEOUT_MS must never be the thing that
      // resolves this — endTerminal has to reject pendingDeliveryMode
      // directly, well within a couple of seconds.
      expect(elapsedMs).toBeLessThan(5_000);
    },
    10_000
  );

  it(
    'rejects a pending delivery-mode PUT promptly when the transport disconnects and takes the ' +
      'bounded-reconnect path, instead of hanging for the full timeout',
    async () => {
      const remote = await startFakeRemote();
      cleanup.push(remote.close);
      const proxy = await startFleetNodeAttachProxy({
        agent: 'agent-c',
        node: 'node-c',
        mode: 'drive',
        baseUrl: 'https://fake.example',
        workspaceKey: 'wk',
        fetch: fakeTicketFetch(remote.url),
      });
      cleanup.push(proxy.close);

      const socket = await remote.nextConnection();
      sendReady(socket, 'auto_inject');
      socket.on('message', (data) => {
        const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (frame.type === 'terminal.set_delivery_mode') {
          // The lane drops mid-PUT: no reply, just a raw disconnect. Relaycast
          // drops the old lane's terminal session state, so a reconnect can
          // never resurrect a reply to this specific request.
          socket.terminate();
        }
      });

      const started = Date.now();
      const result = await putDeliveryMode(proxy, 'agent-c', 'manual_flush');
      const elapsedMs = Date.now() - started;

      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({ error: { code: 'delivery_mode_disconnected' } });
      expect(elapsedMs).toBeLessThan(5_000);
    },
    10_000
  );

  it('rejects a pending delivery-mode PUT promptly when close() tears the proxy down cleanly', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-d',
      node: 'node-d',
      mode: 'drive',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });

    const socket = await remote.nextConnection();
    sendReady(socket, 'auto_inject');
    let sawSetDeliveryMode: () => void;
    const gotFrame = new Promise<void>((resolve) => {
      sawSetDeliveryMode = resolve;
    });
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      // Deliberately never reply — close() must cancel the pending PUT on
      // its own rather than relying on a remote reply that will never come.
      if (frame.type === 'terminal.set_delivery_mode') sawSetDeliveryMode();
    });

    const started = Date.now();
    const putPromise = putDeliveryMode(proxy, 'agent-d', 'manual_flush');
    await gotFrame;
    await proxy.close();
    const result = await putPromise;
    const elapsedMs = Date.now() - started;

    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: { code: 'closed' } });
    expect(elapsedMs).toBeLessThan(5_000);
  }, 10_000);
});

describe('startFleetNodeAttachProxy view target lifecycle', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop()!;
      await fn().catch(() => undefined);
    }
  });

  // MUST NOT FIRE: the HTTP upgrade and terminal.ready are independently
  // bounded. This crosses the old fixed 10s local readiness gate while staying
  // within the 10s handshake plus 3s post-open readiness allowances.
  it('starts the terminal.ready timeout after a delayed WebSocket upgrade completes', async () => {
    const remote = await startFakeRemote(8_000);
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-delayed-upgrade',
      node: 'node-delayed-upgrade',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: { readyTimeoutMs: 3_000 },
    });
    cleanup.push(proxy.close);

    void remote.nextConnection().then(
      (socket) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            sendReady(socket);
            resolve();
          }, 2_500);
        })
    );
    const response = await fetch(`${proxy.brokerUrl}/api/spawned/view-delayed-upgrade/snapshot`, {
      headers: { Authorization: `Bearer ${proxy.apiKey}` },
    });

    expect(response.status).toBe(200);
  }, 15_000);

  // MUST NOT FIRE: a readiness-gated request created during reconnect backoff
  // must follow the next generation instead of expiring after only one
  // handshake/readiness allowance.
  it('keeps a snapshot request pending through bounded reconnect backoff', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-backoff-snapshot',
      node: 'node-backoff-snapshot',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: {
        initialMs: 150,
        maxMs: 150,
        handshakeTimeoutMs: 50,
        readyTimeoutMs: 50,
      },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial);
    initial.terminate();
    await new Promise<void>((resolve) => initial.once('close', () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const responsePromise = fetch(`${proxy.brokerUrl}/api/spawned/view-backoff-snapshot/snapshot`, {
      headers: { Authorization: `Bearer ${proxy.apiKey}` },
    });
    const resumed = await remote.nextConnection();
    sendReady(resumed);

    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  it('keeps a healthy idle view open, then closes it with code and reason when its target disappears', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-target',
      node: 'view-node',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    const remoteSocket = await remote.nextConnection();
    sendReady(remoteSocket, 'auto_inject');
    const viewSocket = await connectLoopbackEvents(proxy);
    const closes: Array<{ code: number; reason: string }> = [];
    const closed = new Promise<void>((resolve) => {
      viewSocket.on('close', (code, reason) => {
        closes.push({ code, reason: reason.toString('utf8') });
        resolve();
      });
    });

    // MUST NOT FIRE: readiness and ordinary output from a healthy target do
    // not finalize its view. Waiting for the output on the real loopback WS is
    // the ordering barrier; this is not a fixed-time assertion of silence.
    const receivedOutput = new Promise<void>((resolve) => viewSocket.once('message', () => resolve()));
    remoteSocket.send(
      JSON.stringify({
        type: 'terminal.output',
        session_id: SESSION_ID,
        chunk: 'healthy target output',
        offset: 1,
      })
    );
    await receivedOutput;
    expect(viewSocket.readyState).toBe(WsClient.OPEN);
    expect(closes).toEqual([]);

    // MUST FIRE: the broker's final target-disappearance frame must reach the
    // actual view client surface as the same actionable close used by drive.
    remoteSocket.send(
      JSON.stringify({
        type: 'terminal.closed',
        session_id: SESSION_ID,
        code: 'agent_released',
        message: 'terminal worker was released',
      })
    );
    await closed;
    expect(closes).toEqual([{ code: 1011, reason: 'remote terminal session closed' }]);
  });

  it('recovers on the sixth resume attempt instead of exhausting the old 15.5s budget', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-reconnect',
      node: 'node-reconnect',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial);
    const viewSocket = await connectLoopbackEvents(proxy);
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          if (viewSocket.readyState === WsClient.CLOSED) return resolve();
          viewSocket.once('close', () => resolve());
          viewSocket.close();
        })
    );

    initial.terminate();
    // Five failed resumes exhausted the pre-fix budget. The sixth is the
    // must-fire boundary: it has to be attempted and accepted.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failedResume = await remote.nextConnection();
      failedResume.terminate();
    }
    const recovered = await remote.nextConnection();
    sendReady(recovered);

    const output = new Promise<void>((resolve) => viewSocket.once('message', () => resolve()));
    recovered.send(
      JSON.stringify({
        type: 'terminal.output',
        session_id: SESSION_ID,
        chunk: 'recovered after the old budget',
        offset: 1,
      })
    );
    await output;
    expect(viewSocket.readyState).toBe(WsClient.OPEN);
  });

  it('closes the local view with a bounded diagnostic after resume attempts are exhausted', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-exhaust',
      // Force the compact diagnostic through the RFC 6455 123-byte truncation
      // path, including a multi-byte UTF-8 boundary.
      node: `node-exhaust-${'é'.repeat(100)}`,
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial);
    const viewSocket = await connectLoopbackEvents(proxy);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      viewSocket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });

    initial.terminate();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const failedResume = await remote.nextConnection();
      failedResume.terminate();
    }

    const result = await closed;
    expect(result.code).toBe(1011);
    expect(Buffer.byteLength(result.reason, 'utf8')).toBeLessThanOrEqual(123);
    expect(result.reason).toContain('terminal reconnect failed');
    expect(result.reason).toContain('attempts=6');
    expect(result.reason).toContain('budget=6ms');
    expect(result.reason).not.toContain('�');
  });

  // MUST FIRE: a successful WebSocket upgrade without terminal.ready used to
  // bypass both the ws handshake timeout and the close-driven retry loop,
  // leaving an established local view falsely open forever.
  it('times out accepted-but-stalled resumes and exhausts the bounded retry path', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    let injectedLateReady = false;
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-stalled-resume',
      node: 'node-stalled-resume',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: {
        initialMs: 1,
        maxMs: 1,
        readyTimeoutMs: 20,
        beforeReadyTimeoutTerminate: (socket) => {
          if (injectedLateReady) return;
          injectedLateReady = true;
          // Simulate terminal.ready already buffered in ws when the deadline
          // fires. The expired generation must ignore it before termination.
          socket.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'terminal.ready',
                session_id: SESSION_ID,
                screen: 'late stale screen',
                rows: 24,
                cols: 80,
                offset: 0,
              })
            )
          );
        },
      },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial);
    const viewSocket = await connectLoopbackEvents(proxy);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      viewSocket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });

    initial.terminate();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const stalledResume = await remote.nextConnection();
      await new Promise<void>((resolve) => {
        if (stalledResume.readyState === WsClient.CLOSED) {
          resolve();
          return;
        }
        stalledResume.once('close', () => resolve());
      });
    }

    const result = await closed;
    expect(injectedLateReady).toBe(true);
    expect(result.code).toBe(1011);
    expect(result.reason).toContain('terminal reconnect failed');
    expect(result.reason).toContain('attempts=6');
    expect(result.reason).toContain('budget=6ms');
  });
});

describe('startFleetNodeAttachProxy readiness-gate status mapping', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop()!;
      await fn().catch(() => undefined);
    }
  });

  /**
   * Bind and immediately release a loopback port so a connection to it is a
   * genuine transport failure (ECONNREFUSED) rather than a simulated one.
   */
  async function reserveClosedPortUrl(): Promise<string> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const { port } = wss.address() as AddressInfo;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    return `ws://127.0.0.1:${port}/v1/nodes/node-resolved/terminal/connect`;
  }

  async function startProxyAgainst(remoteUrl: string, agent: string): Promise<FleetNodeAttachProxy> {
    const proxy = await startFleetNodeAttachProxy({
      agent,
      node: 'node-mapping',
      mode: 'drive',
      baseUrl: 'https://fake.example',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remoteUrl),
    });
    cleanup.push(proxy.close);
    return proxy;
  }

  // MUST FIRE: this fails if the readiness gate collapses agent_not_found into
  // a generic 503. Only a 404 makes switchInboundDeliveryModeOrAbort emit the
  // "no agent named X" / cross-node placement hint, which is the whole point
  // of relay#1535 DoD 4.
  it('answers 404 when readiness fails with agent_not_found, not a generic 503', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startProxyAgainst(remote.url, 'agent-missing');

    const socket = await remote.nextConnection();
    socket.send(
      JSON.stringify({
        type: 'terminal.error',
        session_id: SESSION_ID,
        code: 'agent_not_found',
        message: "no agent named 'agent-missing'",
      })
    );

    const result = await putDeliveryMode(proxy, 'agent-missing', 'auto_inject');
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({
      error: { code: 'agent_not_found', message: "no agent named 'agent-missing'" },
    });
  });

  it('answers 409 when readiness fails with unsupported_runtime', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startProxyAgainst(remote.url, 'agent-runtime');

    const socket = await remote.nextConnection();
    socket.send(
      JSON.stringify({
        type: 'terminal.error',
        session_id: SESSION_ID,
        code: 'unsupported_runtime',
        message: 'agent runtime does not expose a terminal',
      })
    );

    const result = await putDeliveryMode(proxy, 'agent-runtime', 'auto_inject');
    expect(result.status).toBe(409);
    // Assert the message, not just the code: preserving the nested broker
    // message is the point of this PR, so a code-only assertion would still
    // pass if the message were dropped or coerced to `[object Object]`.
    expect(result.body).toMatchObject({
      error: { code: 'unsupported_runtime', message: 'agent runtime does not expose a terminal' },
    });
  });

  // MUST NOT FIRE: a real transport failure has to stay 503, so the mapping
  // above cannot be satisfied by blanket-404ing every readiness rejection.
  it('still answers 503 when the terminal transport genuinely fails to connect', async () => {
    const deadUrl = await reserveClosedPortUrl();
    const proxy = await startProxyAgainst(deadUrl, 'agent-dead');

    const result = await putDeliveryMode(proxy, 'agent-dead', 'auto_inject');
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      error: {
        code: 'node_unreachable',
        message:
          'terminal transport could not connect to the fleet node (node ref "node-mapping",' +
          ` resolved node id "node-resolved", endpoint "${deadUrl}", handshake budget 10000ms,` +
          ' attempts 1; not retried because no terminal session became ready)',
      },
    });
  });

  // The snapshot path already mapped 404 correctly; lock it so the shared
  // helper cannot regress one caller while leaving the other intact.
  it('answers 404 on the snapshot path when readiness fails with agent_not_found', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startProxyAgainst(remote.url, 'agent-missing-snap');

    const socket = await remote.nextConnection();
    socket.send(
      JSON.stringify({
        type: 'terminal.error',
        session_id: SESSION_ID,
        code: 'agent_not_found',
        message: "no agent named 'agent-missing-snap'",
      })
    );

    const response = await fetch(`${proxy.brokerUrl}/api/spawned/agent-missing-snap/snapshot`, {
      headers: { Authorization: `Bearer ${proxy.apiKey}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'agent_not_found', message: "no agent named 'agent-missing-snap'" },
    });
  });
});

describe('startFleetNodeAttachProxy workspace-key precedence', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop()!;
      await fn().catch(() => undefined);
    }
  });

  /** Ticket fetch that records the Authorization header it was called with. */
  function capturingTicketFetch(remoteUrl: string): {
    fetch: typeof globalThis.fetch;
    authorization: () => string | undefined;
  } {
    let seen: string | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen = headers.Authorization;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            session_id: SESSION_ID,
            terminal_url: `${remoteUrl}?ticket=abc`,
            resume_token: RESUME_TOKEN,
          },
        }),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    return { fetch: fetchFn, authorization: () => seen };
  }

  it('presents an explicit workspace key ahead of the ambient environment', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const ticket = capturingTicketFetch(remote.url);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-e',
      node: 'node-e',
      mode: 'view',
      baseUrl: 'https://fake.example',
      workspaceKey: 'rk_live_explicit',
      env: { RELAY_WORKSPACE_KEY: 'rk_live_ambient' },
      fetch: ticket.fetch,
    });
    cleanup.push(proxy.close);

    expect(ticket.authorization()).toBe('Bearer rk_live_explicit');
  });

  it('falls back to the environment when no explicit key is supplied', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const ticket = capturingTicketFetch(remote.url);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-f',
      node: 'node-f',
      mode: 'view',
      baseUrl: 'https://fake.example',
      env: { RELAY_WORKSPACE_KEY: 'rk_live_ambient' },
      fetch: ticket.fetch,
    });
    cleanup.push(proxy.close);

    expect(ticket.authorization()).toBe('Bearer rk_live_ambient');
  });
});
