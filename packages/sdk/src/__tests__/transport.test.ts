import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

import { AgentRelayProtocolError, BrokerTransport } from '../transport.js';

const TEST_BASE_URL = 'http://127.0.0.1:3888';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrokerTransport.request', () => {
  it('returns undefined for empty successful responses', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const transport = new BrokerTransport({ baseUrl: TEST_BASE_URL, fetch: fetchMock as typeof fetch });

    await expect(transport.request<void>('/empty')).resolves.toBeUndefined();
  });

  it('returns undefined for content-length zero successful responses', async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 200, headers: { 'content-length': '0' } })
    );
    const transport = new BrokerTransport({ baseUrl: TEST_BASE_URL, fetch: fetchMock as typeof fetch });

    await expect(transport.request<void>('/empty')).resolves.toBeUndefined();
  });

  it('keeps invalid_response for non-empty malformed JSON responses', async () => {
    const fetchMock = vi.fn(
      async () => new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const transport = new BrokerTransport({ baseUrl: TEST_BASE_URL, fetch: fetchMock as typeof fetch });

    await expect(transport.request('/bad-json')).rejects.toMatchObject<Partial<AgentRelayProtocolError>>({
      code: 'invalid_response',
      status: 200,
    });
  });

  it('replaces differently-cased API key headers instead of duplicating them', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const transport = new BrokerTransport({
      baseUrl: TEST_BASE_URL,
      apiKey: 'configured-key',
      fetch: fetchMock as typeof fetch,
    });

    await transport.request('/headers', { headers: { 'x-api-key': 'caller-key' } });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ 'X-API-Key': 'configured-key' });
  });
});

describe('BrokerTransport.openInputStream', () => {
  it('opens an authenticated websocket and preserves send ordering through acks', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const received: string[] = [];
    let requestUrl: string | undefined;
    let apiKey: string | string[] | undefined;

    server.on('connection', (socket, request) => {
      requestUrl = request.url;
      apiKey = request.headers['x-api-key'];
      socket.send(JSON.stringify({ type: 'pty_input_ready', name: 'worker a' }));
      socket.on('message', (data) => {
        const text = data.toString();
        received.push(text);
        socket.send(
          JSON.stringify({
            type: 'pty_input_ack',
            name: 'worker a',
            bytes_written: Buffer.byteLength(text),
          })
        );
      });
    });

    try {
      await waitForWebSocketServer(server);
      const { port } = server.address() as AddressInfo;
      const transport = new BrokerTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'secret',
      });
      const stream = transport.openInputStream('worker a');
      await stream.waitUntilOpen();

      await expect(stream.send('a')).resolves.toEqual({ name: 'worker a', bytes_written: 1 });
      await expect(stream.send('bc')).resolves.toEqual({ name: 'worker a', bytes_written: 2 });

      expect(requestUrl).toBe('/api/input/worker%20a/stream');
      expect(apiKey).toBe('secret');
      expect(received).toEqual(['a', 'bc']);

      stream.close();
    } finally {
      await closeWebSocketServer(server);
    }
  });

  it('rejects queued input instead of buffering past the high water mark', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'pty_input_ready', name: 'worker' }));
    });

    try {
      await waitForWebSocketServer(server);
      const { port } = server.address() as AddressInfo;
      const transport = new BrokerTransport({ baseUrl: `http://127.0.0.1:${port}` });
      const stream = transport.openInputStream('worker', { highWaterMarkBytes: 3 });
      await stream.waitUntilOpen();

      const first = stream.send('abc');
      await expect(stream.send('d')).rejects.toMatchObject<Partial<AgentRelayProtocolError>>({
        code: 'input_backpressure',
      });

      stream.close();
      await expect(first).rejects.toMatchObject<Partial<AgentRelayProtocolError>>({
        code: 'input_stream_closed',
      });
    } finally {
      await closeWebSocketServer(server);
    }
  });

  it('surfaces broker stream errors during the ready handshake', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    server.on('connection', (socket) => {
      socket.send(
        JSON.stringify({
          type: 'pty_input_error',
          code: 'agent_not_found',
          message: "agent_not_found: no worker named 'ghost'",
          statusCode: 404,
        })
      );
      socket.close();
    });

    try {
      await waitForWebSocketServer(server);
      const { port } = server.address() as AddressInfo;
      const transport = new BrokerTransport({ baseUrl: `http://127.0.0.1:${port}` });
      const stream = transport.openInputStream('ghost');

      await expect(stream.waitUntilOpen()).rejects.toMatchObject<Partial<AgentRelayProtocolError>>({
        code: 'agent_not_found',
        status: 404,
      });
      await expect(stream.send('x')).rejects.toMatchObject<Partial<AgentRelayProtocolError>>({
        code: 'input_stream_closed',
      });
    } finally {
      await closeWebSocketServer(server);
    }
  });
});

async function waitForWebSocketServer(server: WebSocketServer): Promise<void> {
  if (server.address()) return;
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
