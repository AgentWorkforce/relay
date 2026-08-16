/**
 * Delivery-mode PUT lifecycle tests for the fleet-node loopback attach
 * adapter. These stand up a real local WebSocketServer to play the role of
 * the remote Relaycast terminal endpoint, and drive the real loopback HTTP
 * server the adapter starts (via Node's built-in fetch), so the behaviour
 * under test is the actual runtime wiring rather than a mocked stand-in.
 */
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

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

async function startFakeRemote(): Promise<FakeRemoteHandle> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  const connections: WsSocket[] = [];
  const waiters: Array<(socket: WsSocket) => void> = [];
  wss.on('connection', (socket) => {
    connections.push(socket);
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
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
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      receivedFrames.push(frame);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receivedFrames).toEqual([]);

    sendReady(socket, 'manual_flush');
    await expect(resultPromise).resolves.toMatchObject({
      status: 200,
      body: { mode: 'auto_inject', matched: true },
    });
    expect(receivedFrames).toHaveLength(1);
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
