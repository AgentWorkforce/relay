/**
 * Delivery-mode PUT lifecycle tests for the fleet-node loopback attach
 * adapter. These stand up a real local WebSocketServer to play the role of
 * the remote Relaycast terminal endpoint, and drive the real loopback HTTP
 * server the adapter starts (via Node's built-in fetch), so the behaviour
 * under test is the actual runtime wiring rather than a mocked stand-in.
 */
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebSocket as WsClient, WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  decodeAnsiScreenPayload,
  inputErrorIsConnectionFatal,
  startFleetNodeAttachProxy,
  type FleetNodeAttachProxy,
} from './attach-fleet-node.js';
import { writeProjectWorkspaceKey } from './project-workspace-key.js';

const SESSION_ID = 'session-under-test';
const RESUME_TOKEN = 'resume-token';

type FakeRemoteHandle = {
  wss: WebSocketServer;
  url: string;
  /** Resolves with the first socket that connects. */
  nextConnection: () => Promise<WsSocket>;
  close: () => Promise<void>;
};

async function startFakeRemote(
  upgradeDelayMs = 0,
  rejectUpgrade?: (url: string) => number | undefined
): Promise<FakeRemoteHandle> {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    ...(upgradeDelayMs > 0 || rejectUpgrade
      ? {
          verifyClient: (info, done) => {
            const status = rejectUpgrade?.(info.req.url ?? '/');
            setTimeout(
              () =>
                status === undefined
                  ? done(true)
                  : done(false, status, status === 410 ? 'Gone' : 'Unavailable'),
              upgradeDelayMs
            );
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

function sendReady(
  socket: WsSocket,
  deliveryMode?: 'auto_inject' | 'manual_flush',
  sessionId = SESSION_ID,
  /**
   * Wire value for `terminal.ready.screen`. The broker asks the worker for
   * `format: "ansi"`, which base64-encodes the rendered grid, so a realistic
   * frame carries base64 here — never raw ANSI.
   */
  screen = ''
): void {
  socket.send(
    JSON.stringify({
      type: 'terminal.ready',
      session_id: sessionId,
      screen,
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
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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

  // MUST NOT FIRE: exhausting the aggregate budget during retry backoff must
  // retain the last structured rejection instead of replacing its status,
  // code, and upstream message with a generic timeout sentinel.
  it('preserves the last classified failure when the overall budget expires between attempts', async () => {
    let calls = 0;
    let now = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchFn = (async () => {
      calls += 1;
      return terminalSessionErrorResponse(
        'node_unreachable',
        "Node 'node-budget-expired' has no terminal transport"
      );
    }) as typeof globalThis.fetch;

    try {
      const rejectedPromise = startFleetNodeAttachProxy({
        agent: 'agent-budget-expired',
        node: 'node-budget-expired',
        mode: 'view',
        baseUrl: 'https://cast.agentrelay.com',
        workspaceKey: 'wk',
        fetch: fetchFn,
        sessionRequest: {
          totalTimeoutMs: 10,
          sleep: async (delayMs) => {
            now += delayMs;
          },
        },
      }).catch((error: unknown) => error);

      const rejected = await rejectedPromise;

      expect(calls).toBe(1);
      // Deadline exhaustion gets one final callback so it can annotate the
      // diagnostic, then the non-retryable clone stops collectWithRetry instead
      // of spinning through the remaining retry slots.
      expect(nowSpy).toHaveBeenCalledTimes(4);
      expect(rejected).toMatchObject({ code: 'node_unreachable' });
      expect((rejected as Error).message).toContain('terminal transport was unavailable');
      expect((rejected as Error).message).toContain("Node 'node-budget-expired' has no terminal transport");
      expect((rejected as Error).message).toContain('HTTP 503');
      expect((rejected as Error).message).toContain('overall budget 10ms');
      expect((rejected as Error).message).toContain(
        'attempts 1 (not retried because the overall budget was exhausted before the next attempt)'
      );
    } finally {
      nowSpy.mockRestore();
    }
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
      baseUrl: 'https://cast.agentrelay.com',
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
      'endpoint "https://cast.agentrelay.com/v1/nodes/node-dead/terminal/sessions"'
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
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    // Six complete reconnect generations (151.5s), one bounded replacement
    // session allocation including safe structured retries (90s), the post-ready delivery acknowledgement
    // (10s), and response-delivery headroom (1s).
    expect(proxy.requestTimeoutMs).toBe(252_500);

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
      baseUrl: 'https://cast.agentrelay.com',
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
        baseUrl: 'https://cast.agentrelay.com',
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
        baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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
  // within the 10s handshake plus 4s post-open readiness allowances.
  it('starts the terminal.ready timeout after a delayed WebSocket upgrade completes', async () => {
    const remote = await startFakeRemote(8_000);
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-delayed-upgrade',
      node: 'node-delayed-upgrade',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: { handshakeTimeoutMs: 10_000, readyTimeoutMs: 4_000 },
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
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: {
        initialMs: 150,
        maxMs: 150,
        handshakeTimeoutMs: 500,
        readyTimeoutMs: 500,
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
      baseUrl: 'https://cast.agentrelay.com',
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

  // MUST FIRE: cast terminal sessions have a finite lifetime. Before this
  // regression, a view that outlived its session kept retrying the expired
  // resume token six times and then closed its local client with code 1011.
  it('replaces an expired terminal session once and keeps the existing view attached', async () => {
    const oldSessionId = 'session-expired';
    const freshSessionId = 'session-fresh';
    let resumeRequests = 0;
    const remote = await startFakeRemote(0, (requestUrl) => {
      const url = new URL(requestUrl, 'ws://127.0.0.1');
      if (url.searchParams.get('resume')) {
        resumeRequests += 1;
        return 410;
      }
      return undefined;
    });
    cleanup.push(remote.close);
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      const replacement = requests.length === 2;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          ok: true,
          data: {
            session_id: replacement ? freshSessionId : oldSessionId,
            terminal_url: `${remote.url}?ticket=${replacement ? 'fresh-ticket' : 'old-ticket'}`,
            resume_token: replacement ? 'fresh-resume-secret' : 'old-resume-secret',
            expires_at: replacement
              ? new Date(Date.now() + 600_000).toISOString()
              : new Date(Date.now() - 1).toISOString(),
          },
        }),
      } as Response;
    }) as typeof globalThis.fetch;
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-expired',
      node: 'node-expired',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fetchFn,
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial, 'auto_inject', oldSessionId);
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
    const replacement = await remote.nextConnection();
    sendReady(replacement, 'auto_inject', freshSessionId);
    const output = new Promise<void>((resolve) => viewSocket.once('message', () => resolve()));
    replacement.send(
      JSON.stringify({
        type: 'terminal.output',
        session_id: freshSessionId,
        chunk: 'fresh session output',
        offset: 1,
      })
    );
    await output;

    expect(viewSocket.readyState).toBe(WsClient.OPEN);
    expect(requests).toEqual([
      {
        url: 'https://cast.agentrelay.com/v1/nodes/node-expired/terminal/sessions',
        body: { agent: 'view-expired', mode: 'view' },
      },
      {
        url: 'https://cast.agentrelay.com/v1/nodes/node-expired/terminal/sessions',
        body: { agent: 'view-expired', mode: 'view' },
      },
    ]);
    expect(resumeRequests).toBe(0);
  });

  it.each([401, 410])(
    'replaces a session once when the terminal rejects its resume credential with %i',
    async (rejectedStatus) => {
      const oldSessionId = 'session-resume-expired';
      const freshSessionId = 'session-after-expired-resume';
      let resumeRequests = 0;
      const remote = await startFakeRemote(0, (requestUrl) => {
        const url = new URL(requestUrl, 'ws://127.0.0.1');
        if (url.searchParams.get('resume')) {
          resumeRequests += 1;
          return rejectedStatus;
        }
        return undefined;
      });
      cleanup.push(remote.close);
      let sessionRequests = 0;
      const proxy = await startFleetNodeAttachProxy({
        agent: 'view-resume-expired',
        node: 'node-resume-expired',
        mode: 'view',
        baseUrl: 'https://cast.agentrelay.com',
        workspaceKey: 'wk',
        fetch: (async () => {
          sessionRequests += 1;
          const replacement = sessionRequests === 2;
          return {
            ok: true,
            status: 201,
            json: async () => ({
              ok: true,
              data: {
                session_id: replacement ? freshSessionId : oldSessionId,
                terminal_url: `${remote.url}?ticket=${replacement ? 'fresh-ticket' : 'old-ticket'}`,
                resume_token: replacement ? 'fresh-resume-secret' : 'old-resume-secret',
                expires_at: new Date(Date.now() + 600_000).toISOString(),
              },
            }),
          } as Response;
        }) as typeof globalThis.fetch,
        reconnectDelay: { initialMs: 1, maxMs: 1 },
      });
      cleanup.push(proxy.close);

      const initial = await remote.nextConnection();
      sendReady(initial, 'auto_inject', oldSessionId);
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
      const replacement = await remote.nextConnection();
      sendReady(replacement, 'auto_inject', freshSessionId);
      const output = new Promise<void>((resolve) => viewSocket.once('message', () => resolve()));
      replacement.send(
        JSON.stringify({
          type: 'terminal.output',
          session_id: freshSessionId,
          chunk: 'fresh after expired resume',
          offset: 1,
        })
      );
      await output;

      expect(viewSocket.readyState).toBe(WsClient.OPEN);
      expect(resumeRequests).toBe(1);
      expect(sessionRequests).toBe(2);
    }
  );

  it('does not allocate a replacement terminal for transient resume failures', async () => {
    let resumeRequests = 0;
    const remote = await startFakeRemote(0, (requestUrl) => {
      if (new URL(requestUrl, 'ws://127.0.0.1').searchParams.get('resume')) {
        resumeRequests += 1;
        return 503;
      }
      return undefined;
    });
    cleanup.push(remote.close);
    let sessionRequests = 0;
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-transient-resume',
      node: 'node-transient-resume',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: (async () => {
        sessionRequests += 1;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            data: {
              session_id: SESSION_ID,
              terminal_url: `${remote.url}?ticket=initial-ticket`,
              resume_token: 'initial-resume-secret',
              expires_at: new Date(Date.now() + 600_000).toISOString(),
            },
          }),
        } as Response;
      }) as typeof globalThis.fetch,
      sessionRequest: { sleep: async () => undefined },
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial);
    const viewSocket = await connectLoopbackEvents(proxy);
    const closed = new Promise<void>((resolve) => viewSocket.once('close', () => resolve()));
    initial.terminate();
    await closed;

    expect(resumeRequests).toBe(6);
    expect(sessionRequests).toBe(1);
  });

  it('uses the terminal-session request timeout, not the WebSocket handshake timeout, for replacement allocation', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    let requests = 0;
    let replacementAborted = false;
    let resolveReplacementAbort!: () => void;
    const replacementAbort = new Promise<void>((resolve) => {
      resolveReplacementAbort = resolve;
    });
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-replacement-timeout',
      node: 'node-replacement-timeout',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: ((_: string | URL | Request, init?: RequestInit) => {
        requests += 1;
        if (requests === 1) {
          return Promise.resolve({
            ok: true,
            status: 201,
            json: async () => ({
              ok: true,
              data: {
                session_id: SESSION_ID,
                terminal_url: `${remote.url}?ticket=initial-ticket`,
                resume_token: 'initial-resume-secret',
                expires_at: new Date(Date.now() - 1).toISOString(),
              },
            }),
          } as Response);
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              replacementAborted = true;
              resolveReplacementAbort();
              reject(new Error('replacement request aborted'));
            },
            { once: true }
          );
        });
      }) as typeof globalThis.fetch,
      sessionRequest: { timeoutMs: 40, totalTimeoutMs: 40 },
      reconnectDelay: { initialMs: 1, maxMs: 1, handshakeTimeoutMs: 5 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial);
    initial.terminate();
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(replacementAborted).toBe(false);
    await replacementAbort;
    expect(requests).toBe(2);
  });

  it('preserves a replacement allocation failure code for readiness-gated requests', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    let requests = 0;
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-replacement-error',
      node: 'node-replacement-error',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: (async () => {
        requests += 1;
        if (requests >= 2) {
          return terminalSessionErrorResponse(
            'terminal_session_unavailable',
            'replacement terminal session is unavailable'
          );
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            ok: true,
            data: {
              session_id: SESSION_ID,
              terminal_url: `${remote.url}?ticket=initial-ticket`,
              resume_token: 'initial-resume-secret',
              expires_at: new Date(Date.now() - 1).toISOString(),
            },
          }),
        } as Response;
      }) as typeof globalThis.fetch,
      sessionRequest: { sleep: async () => undefined },
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial);
    initial.terminate();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const response = await fetch(`${proxy.brokerUrl}/api/spawned/view-replacement-error/snapshot`, {
      headers: { Authorization: `Bearer ${proxy.apiKey}` },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'terminal_session_unavailable' },
    });
    expect(requests).toBe(6);
  });

  it('recovers on the sixth resume attempt instead of exhausting the old 15.5s budget', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'view-reconnect',
      node: 'node-reconnect',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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
      baseUrl: 'https://cast.agentrelay.com',
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
    requestUrl: () => string | undefined;
  } {
    let seen: string | undefined;
    let requestedUrl: string | undefined;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      requestedUrl = url;
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
    return { fetch: fetchFn, authorization: () => seen, requestUrl: () => requestedUrl };
  }

  it('presents an explicit workspace key ahead of the ambient environment', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const ticket = capturingTicketFetch(remote.url);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-e',
      node: 'node-e',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'rk_live_explicit',
      env: { RELAY_WORKSPACE_KEY: 'rk_live_ambient' },
      fetch: ticket.fetch,
    });
    cleanup.push(proxy.close);

    expect(ticket.authorization()).toBe('Bearer rk_live_explicit');
  });

  it('uses an explicit isolated base URL instead of the canonical fallback', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const ticket = capturingTicketFetch(remote.url);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'sandbox-worker',
      node: 'agent37-codex',
      mode: 'view',
      baseUrl: 'https://agent37-cast.agentrelay.com',
      workspaceKey: 'rk_live_agent37_target',
      env: { RELAY_WORKSPACE_KEY: 'rk_live_ambient' },
      fetch: ticket.fetch,
    });
    cleanup.push(proxy.close);

    expect(ticket.requestUrl()).toBe(
      'https://agent37-cast.agentrelay.com/v1/nodes/agent37-codex/terminal/sessions'
    );
    expect(ticket.requestUrl()).not.toBe(
      'https://cast.agentrelay.com/v1/nodes/agent37-codex/terminal/sessions'
    );
  });

  it('binds a matching explicit canonical selector to its persisted isolated key and origin', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const ticket = capturingTicketFetch(remote.url);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-attach-project-'));
    const env = { AGENT_RELAY_HOME: path.join(projectRoot, 'credentials') };
    const priorProject = process.env.AGENT_RELAY_PROJECT;
    process.env.AGENT_RELAY_PROJECT = projectRoot;
    writeProjectWorkspaceKey(path.join(projectRoot, '.agentworkforce/relay'), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_isolated',
      env,
    });

    try {
      const proxy = await startFleetNodeAttachProxy({
        agent: 'sandbox-worker',
        node: 'agent37-codex',
        mode: 'view',
        baseUrl: 'https://agent37-cast.agentrelay.com/',
        workspaceKey: 'rk_live_canonical',
        env,
        fetch: ticket.fetch,
      });
      cleanup.push(proxy.close);

      expect(ticket.authorization()).toBe('Bearer rk_live_isolated');
      expect(ticket.requestUrl()).toBe(
        'https://agent37-cast.agentrelay.com/v1/nodes/agent37-codex/terminal/sessions'
      );
    } finally {
      if (priorProject === undefined) delete process.env.AGENT_RELAY_PROJECT;
      else process.env.AGENT_RELAY_PROJECT = priorProject;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not inherit a persisted route when an explicit key selects a different workspace', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const ticket = capturingTicketFetch(remote.url);
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-attach-project-'));
    const env = { AGENT_RELAY_HOME: path.join(projectRoot, 'credentials') };
    const priorProject = process.env.AGENT_RELAY_PROJECT;
    process.env.AGENT_RELAY_PROJECT = projectRoot;
    writeProjectWorkspaceKey(path.join(projectRoot, '.agentworkforce/relay'), 'rk_live_canonical', {
      workspaceId: 'rw_abc',
      relaycastRoute: 'agent37-isolated',
      relaycastBaseUrl: 'https://agent37-cast.agentrelay.com',
      relaycastApiKey: 'rk_live_isolated',
      env,
    });

    try {
      const proxy = await startFleetNodeAttachProxy({
        agent: 'other-worker',
        node: 'other-node',
        mode: 'view',
        workspaceKey: 'rk_live_other',
        env,
        fetch: ticket.fetch,
      });
      cleanup.push(proxy.close);

      expect(ticket.authorization()).toBe('Bearer rk_live_other');
      expect(ticket.requestUrl()).toBe('https://cast.agentrelay.com/v1/nodes/other-node/terminal/sessions');
    } finally {
      if (priorProject === undefined) delete process.env.AGENT_RELAY_PROJECT;
      else process.env.AGENT_RELAY_PROJECT = priorProject;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'https://evil.example',
    'http://cast.agentrelay.com',
    'https://cast.agentrelay.com.attacker.example',
    'https://cast.agentrelay.com/path',
  ])('rejects an untrusted explicit base URL before sending the workspace key', async (baseUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      startFleetNodeAttachProxy({
        agent: 'agent-attacker',
        node: 'node-attacker',
        mode: 'view',
        baseUrl,
        workspaceKey: 'rk_live_must_not_leave_process',
        env: {},
        fetch,
      })
    ).rejects.toThrow(/trusted Relaycast origin/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the environment when no explicit key is supplied', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const ticket = capturingTicketFetch(remote.url);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-f',
      node: 'node-f',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      env: { RELAY_WORKSPACE_KEY: 'rk_live_ambient' },
      fetch: ticket.fetch,
    });
    cleanup.push(proxy.close);

    expect(ticket.authorization()).toBe('Bearer rk_live_ambient');
  });
});

describe('startFleetNodeAttachProxy flush route', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop()!;
      await fn().catch(() => undefined);
    }
  });

  const postFlush = async (proxy: { brokerUrl: string; apiKey: string }, agent: string) => {
    const response = await fetch(`${proxy.brokerUrl}/api/spawned/${encodeURIComponent(agent)}/flush`, {
      method: 'POST',
      headers: { 'x-api-key': proxy.apiKey },
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  /**
   * The point of the whole change: `node agent message flush --node` has to
   * reach the agent's OWN node. Before this route existed the command only ever
   * queried the local broker's worker registry and answered `agent_not_found`
   * for a name that `node agent list` and `attach` both resolve.
   */
  it('forwards the flush to the remote node and returns its real result', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-remote',
      node: 'node-remote',
      // `view` on purpose: a flush drains an already-held queue without
      // changing delivery mode, so it must not have to seize the single drive
      // slot from whoever is attached.
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    const socket = await remote.nextConnection();
    sendReady(socket, 'manual_flush');
    const forwarded: Array<Record<string, unknown>> = [];
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (frame.type === 'terminal.flush_pending') {
        forwarded.push(frame);
        socket.send(
          JSON.stringify({
            type: 'terminal.flush_pending',
            session_id: SESSION_ID,
            request_id: frame.request_id,
            flushed: 2,
            dead_lettered: 1,
            held: 0,
            blocked_reason: null,
          })
        );
      }
    });

    const result = await postFlush(proxy, 'agent-remote');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      flushed: 2,
      dead_lettered: 1,
      held: 0,
      blocked_reason: null,
    });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.session_id).toBe(SESSION_ID);
  });

  /**
   * A remote `agent_not_found` must surface as a 404, not a generic failure —
   * that status is what tells an operator the agent is on a different machine
   * rather than that the flush itself broke.
   */
  it('maps a remote agent_not_found to 404 rather than a generic failure', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-missing',
      node: 'node-remote',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    const socket = await remote.nextConnection();
    sendReady(socket, 'manual_flush');
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (frame.type === 'terminal.flush_pending') {
        socket.send(
          JSON.stringify({
            type: 'terminal.error',
            session_id: SESSION_ID,
            request_id: frame.request_id,
            code: 'agent_not_found',
            message: "agent 'agent-missing' is not running on this node",
          })
        );
      }
    });

    const result = await postFlush(proxy, 'agent-missing');
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'agent_not_found' } });
  });

  /**
   * Requested in review on #1643: the terminal protocol permits a reply with no
   * request_id, and the proxy always sends one. A no-id `terminal.flush_pending`
   * frame is therefore never ours, and accepting it would resolve the caller's
   * flush with an unrelated node's result — a fabricated success.
   */
  it('ignores a flush reply that carries no request_id and waits for the real one', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-noid',
      node: 'node-remote',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    const socket = await remote.nextConnection();
    sendReady(socket, 'manual_flush');
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (frame.type === 'terminal.flush_pending') {
        // Decoy: correct type, no request_id, wrong numbers.
        socket.send(
          JSON.stringify({
            type: 'terminal.flush_pending',
            session_id: SESSION_ID,
            flushed: 99,
            dead_lettered: 99,
            held: 99,
            blocked_reason: 'decoy',
          })
        );
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              type: 'terminal.flush_pending',
              session_id: SESSION_ID,
              request_id: frame.request_id,
              flushed: 3,
              dead_lettered: 0,
              held: 0,
              blocked_reason: null,
            })
          );
        }, 20);
      }
    });

    const result = await postFlush(proxy, 'agent-noid');
    expect(result.status).toBe(200);
    // The decoy must not have won.
    expect(result.body).toMatchObject({ flushed: 3, dead_lettered: 0, blocked_reason: null });
  });

  /**
   * A session-level error carrying no request_id must NOT resolve a pending
   * flush. Flush is a new frame with no older-broker compatibility to preserve,
   * so an unrelated failure resolving it would be a false result — the exact
   * shape of bug this change exists to remove.
   */
  it('does not let an unrelated session error resolve a pending flush', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-cross',
      node: 'node-remote',
      mode: 'view',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
    });
    cleanup.push(proxy.close);

    const socket = await remote.nextConnection();
    sendReady(socket, 'manual_flush');
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (frame.type === 'terminal.flush_pending') {
        // No request_id: a session-scoped error, not a reply to this flush.
        socket.send(
          JSON.stringify({
            type: 'terminal.error',
            session_id: SESSION_ID,
            code: 'pty_write_failed',
            message: 'unrelated session failure',
          })
        );
        // The real reply arrives after it and must be the one that wins.
        setTimeout(() => {
          socket.send(
            JSON.stringify({
              type: 'terminal.flush_pending',
              session_id: SESSION_ID,
              request_id: frame.request_id,
              flushed: 1,
              dead_lettered: 0,
              held: 0,
              blocked_reason: null,
            })
          );
        }, 20);
      }
    });

    const result = await postFlush(proxy, 'agent-cross');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ flushed: 1 });
  });
});

/**
 * Regression suite for relay#1829: after an established fleet-node terminal
 * transport reconnects, the adapter re-emitted the new generation's
 * `terminal.ready.screen` as a `worker_stream` chunk. That field is
 * base64-encoded ANSI (the broker requests `format: "ansi"`, which encodes),
 * while a `worker_stream` chunk is raw PTY bytes an attach client writes to
 * the terminal verbatim — so the operator saw a wall of base64 text instead of
 * a repaint, right alongside the input-stream reconnect notice.
 */
describe('decodeAnsiScreenPayload', () => {
  it('decodes a canonical base64 ANSI screen to renderable bytes', () => {
    const ansi = '\u001b[2J\u001b[H hello \u001b[0m';
    expect(decodeAnsiScreenPayload(Buffer.from(ansi, 'utf8').toString('base64'))).toBe(ansi);
  });

  it('treats an empty screen as empty rather than undecodable', () => {
    expect(decodeAnsiScreenPayload('')).toBe('');
  });

  // MUST FIRE: `Buffer.from(…, 'base64')` silently drops out-of-alphabet
  // characters, so a lenient decode would turn raw ANSI into garbage bytes and
  // still hand them to the terminal. Only the round-trip check rejects them.
  it('rejects raw ANSI mistakenly delivered in the screen field', () => {
    expect(decodeAnsiScreenPayload('\u001b[2J\u001b[Hhello')).toBeNull();
  });

  it('rejects non-canonical and truncated base64', () => {
    expect(decodeAnsiScreenPayload('aGVsbG8')).toBeNull(); // unpadded
    expect(decodeAnsiScreenPayload('a GVsbG8=')).toBeNull(); // embedded space
    expect(decodeAnsiScreenPayload('!!!!')).toBeNull();
  });
});

describe('startFleetNodeAttachProxy reconnect repaint encoding', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop()!;
      await fn().catch(() => undefined);
    }
  });

  const closeLoopback = (socket: WsClient) => () =>
    new Promise<void>((resolve) => {
      if (socket.readyState === WsClient.CLOSED) return resolve();
      socket.once('close', () => resolve());
      socket.close();
    });

  /** Collect every `worker_stream` chunk a loopback `/ws` consumer receives. */
  function collectChunks(socket: WsClient): string[] {
    const chunks: string[] = [];
    socket.on('message', (data) => {
      const event = JSON.parse(String(data)) as { kind?: string; chunk?: string };
      if (event.kind === 'worker_stream' && typeof event.chunk === 'string') chunks.push(event.chunk);
    });
    return chunks;
  }

  async function startProxyWithRemote(agent: string) {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent,
      node: 'node-repaint',
      mode: 'drive',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: { initialMs: 1, maxMs: 1 },
    });
    cleanup.push(proxy.close);
    return { remote, proxy };
  }

  // MUST FIRE: before the fix this received the base64 text itself, which the
  // drive client writes straight to the operator's terminal.
  it('repaints a reconnect with DECODED ANSI, never the base64 payload', async () => {
    const { remote, proxy } = await startProxyWithRemote('agent-repaint');
    const ansiScreen = '\u001b[2J\u001b[Hrestored screen\u001b[0m';
    const encodedScreen = Buffer.from(ansiScreen, 'utf8').toString('base64');

    const initial = await remote.nextConnection();
    sendReady(initial, 'auto_inject', SESSION_ID, encodedScreen);

    const events = await connectLoopbackEvents(proxy);
    cleanup.push(closeLoopback(events));
    const chunks = collectChunks(events);

    // Generation 1: consumers do their own HTTP snapshot, so nothing is
    // pushed. A repaint chunk here would double-paint the initial screen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chunks).toEqual([]);

    const repainted = new Promise<void>((resolve) => events.once('message', () => resolve()));
    initial.terminate();
    const replacement = await remote.nextConnection();
    sendReady(replacement, 'auto_inject', SESSION_ID, encodedScreen);
    await repainted;

    expect(chunks).toEqual([ansiScreen]);
    // The precise defect: the encoded form must never appear in a channel
    // whose bytes are written verbatim to a terminal.
    expect(chunks.join('')).not.toContain(encodedScreen);
  });

  // MUST FIRE: a decode that cannot be trusted must drop the repaint rather
  // than emit mangled bytes. A stale-but-coherent screen beats garbage on a
  // live TTY, and the operator can always re-attach.
  it('drops the reconnect repaint when the screen payload is not valid base64', async () => {
    const { remote, proxy } = await startProxyWithRemote('agent-bad-screen');

    const initial = await remote.nextConnection();
    sendReady(initial, 'auto_inject');

    const events = await connectLoopbackEvents(proxy);
    cleanup.push(closeLoopback(events));
    const chunks = collectChunks(events);

    initial.terminate();
    const replacement = await remote.nextConnection();
    sendReady(replacement, 'auto_inject', SESSION_ID, '\u001b[2Jnot base64 at all');

    // Prove liveness of the replacement generation: real output still flows,
    // so an empty chunk list is a dropped repaint, not a dead transport.
    const delivered = new Promise<void>((resolve) => {
      events.on('message', (data) => {
        if (String(data).includes('live output')) resolve();
      });
    });
    replacement.send(
      JSON.stringify({ type: 'terminal.output', session_id: SESSION_ID, chunk: 'live output', offset: 1 })
    );
    await delivered;

    expect(chunks).toEqual(['live output']);
  });

  // MUST FIRE: `terminal.output` chunks are already raw. Decoding them too
  // would corrupt any agent output that happens to look like base64.
  it('forwards terminal.output chunks verbatim even when they look base64', async () => {
    const { remote, proxy } = await startProxyWithRemote('agent-verbatim');
    const socket = await remote.nextConnection();
    sendReady(socket, 'auto_inject');

    const events = await connectLoopbackEvents(proxy);
    cleanup.push(closeLoopback(events));
    const chunks = collectChunks(events);

    const lookalike = 'aGVsbG8gd29ybGQ=';
    const delivered = new Promise<void>((resolve) => events.once('message', () => resolve()));
    socket.send(
      JSON.stringify({ type: 'terminal.output', session_id: SESSION_ID, chunk: lookalike, offset: 1 })
    );
    await delivered;

    expect(chunks).toEqual([lookalike]);
  });

  // The HTTP snapshot contract is the OTHER side of this boundary and must
  // stay base64: `captureAndRenderSnapshot` decodes it. Changing the repaint
  // must not change this.
  it('keeps serving the HTTP snapshot as base64 for the decoding client', async () => {
    const { remote, proxy } = await startProxyWithRemote('agent-snapshot');
    const ansiScreen = '\u001b[Hsnapshot body';
    const encodedScreen = Buffer.from(ansiScreen, 'utf8').toString('base64');

    const socket = await remote.nextConnection();
    sendReady(socket, 'auto_inject', SESSION_ID, encodedScreen);

    const response = await fetch(`${proxy.brokerUrl}/api/spawned/agent-snapshot/snapshot`, {
      headers: { Authorization: `Bearer ${proxy.apiKey}` },
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ format: 'ansi', screen: encodedScreen, rows: 24, cols: 80, offset: 0 });
    // And the real client decoder turns it back into the renderable screen.
    expect(Buffer.from(String(body.screen), 'base64').toString('utf8')).toBe(ansiScreen);
  });
});

/**
 * The loopback speaks the broker's PTY-input WebSocket contract to the SDK's
 * `PtyInputStream`, which latches `closed` only on socket close. A
 * connection-fatal error delivered on a socket left open therefore never
 * marks the stream dead. When such an error arrives with no write in flight —
 * the session-scoped `terminal.error` path — the client has nothing to reject,
 * never enters recovery, and keeps writing into a stream the node has already
 * declared unusable.
 */
describe('startFleetNodeAttachProxy PTY-input error contract', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()!().catch(() => undefined);
    }
  });

  it('matches the broker on which input errors are connection-fatal', () => {
    // Must agree with `pty_input_error_is_connection_fatal`
    // (crates/broker/src/listen_api.rs). Divergence here silently tears down
    // a socket the other side is still holding open, or vice versa.
    expect(inputErrorIsConnectionFatal('worker_timeout')).toBe(false);
    expect(inputErrorIsConnectionFatal('pty_write_queue_full')).toBe(false);
    expect(inputErrorIsConnectionFatal('node_unreachable')).toBe(true);
    expect(inputErrorIsConnectionFatal('worker_disappeared')).toBe(true);
    expect(inputErrorIsConnectionFatal('agent_not_found')).toBe(true);
  });

  async function connectLoopbackInput(proxy: FleetNodeAttachProxy, agent: string): Promise<WsClient> {
    const socket = new WsClient(
      `${proxy.brokerUrl.replace(/^http/, 'ws')}/api/input/${encodeURIComponent(agent)}/stream`,
      { headers: { Authorization: `Bearer ${proxy.apiKey}` } }
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  }

  // MUST FIRE: before the fix the socket stayed open after `node_unreachable`,
  // so the client never learned its input stream was dead.
  it('closes the input socket after a connection-fatal write failure', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-input-fatal',
      node: 'node-input',
      mode: 'drive',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      // No reconnect: keep the transport down for the whole assertion.
      reconnectDelay: { initialMs: 60_000, maxMs: 60_000 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial, 'auto_inject');

    const input = await connectLoopbackInput(proxy, 'agent-input-fatal');
    const frames: Array<Record<string, unknown>> = [];
    input.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    const closed = new Promise<void>((resolve) => input.once('close', () => resolve()));

    // Drop the node transport, then write into the now-unreachable stream.
    initial.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.send('keystroke');

    await closed;
    const error = frames.find((frame) => frame.type === 'pty_input_error');
    expect(error).toMatchObject({ code: 'node_unreachable', retryable: false });
  });

  // A second attached input stream must not be torn down because THIS one's
  // write failed; the broker reports per-connection, not per-session.
  it('fails only the socket whose write could not be forwarded', async () => {
    const remote = await startFakeRemote();
    cleanup.push(remote.close);
    const proxy = await startFleetNodeAttachProxy({
      agent: 'agent-input-scope',
      node: 'node-input',
      mode: 'drive',
      baseUrl: 'https://cast.agentrelay.com',
      workspaceKey: 'wk',
      fetch: fakeTicketFetch(remote.url),
      reconnectDelay: { initialMs: 60_000, maxMs: 60_000 },
    });
    cleanup.push(proxy.close);

    const initial = await remote.nextConnection();
    sendReady(initial, 'auto_inject');

    const writer = await connectLoopbackInput(proxy, 'agent-input-scope');
    const bystander = await connectLoopbackInput(proxy, 'agent-input-scope');
    let bystanderClosed = false;
    bystander.on('close', () => {
      bystanderClosed = true;
    });
    const writerClosed = new Promise<void>((resolve) => writer.once('close', () => resolve()));

    initial.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    writer.send('keystroke');
    await writerClosed;

    expect(bystanderClosed).toBe(false);
    expect(bystander.readyState).toBe(WsClient.OPEN);
  });
});
