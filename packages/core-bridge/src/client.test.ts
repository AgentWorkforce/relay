import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectCore, tryConnectCore, type CoreClient, type CoreEvent } from './client.js';
import {
  BridgeVersionMismatchError,
  CoreBridgeError,
  CoreClosedError,
  CoreNotRunningError,
  CoreReplyTooLargeError,
  CoreRequestTooLargeError,
  CoreRpcError,
  CoreTimeoutError,
  CoreUntrustedError,
  NotACoreError,
} from './errors.js';
import { BRIDGE_VERSION, MAX_REPLY_BYTES, MAX_REQUEST_BYTES } from './paths.js';

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** What the fake core does with one request: a reply object, or undefined to stay silent. */
type Handler = (request: Request, connection: net.Socket) => Record<string, unknown> | undefined;

const send = (connection: net.Socket, value: unknown) => connection.write(`${JSON.stringify(value)}\n`);

describe.skipIf(process.platform === 'win32')('connectCore', () => {
  let dir: string;
  let socket: string;
  let server: net.Server | undefined;
  const clients: CoreClient[] = [];

  beforeEach(() => {
    // Short: a Unix socket path has a ~104-byte limit.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
    fs.chmodSync(dir, 0o700);
    socket = path.join(dir, 'core.sock');
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const greeting = {
    bridge_version: BRIDGE_VERSION,
    daemon_version: '17.2.1',
    pid: 42,
    methods: ['hello', 'status.get', 'subscribe'],
    topics: ['status'],
  };

  /**
   * A tiny NDJSON core: answers hello and status.get, sends an event before
   * every reply, refuses the rest. `handler` overrides any method it answers.
   */
  async function serve(seen: string[] = [], hello: unknown = greeting, handler?: Handler): Promise<void> {
    server = net.createServer((connection) => {
      let buffer = '';
      connection.on('error', () => {});
      connection.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as Request;
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          seen.push(`${request.method} ${JSON.stringify(request.params)}`);
          send(connection, { jsonrpc: '2.0', method: 'event', params: { revision: 3 } });
          const custom = request.method === 'hello' ? undefined : handler?.(request, connection);
          if (custom === undefined && handler && request.method !== 'hello') continue;
          const reply =
            custom ??
            (request.method === 'hello'
              ? { result: hello }
              : request.method === 'status.get'
                ? { result: { daemon: { pid: 42, version: '15.0.0', socket } } }
                : { error: { code: -32601, message: 'Unknown method.' } });
          send(connection, { jsonrpc: '2.0', id: request.id, ...reply });
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(socket, resolve));
    // The core binds its socket 0600.
    fs.chmodSync(socket, 0o600);
  }

  async function connect(timeoutMs = 2_000): Promise<CoreClient> {
    const client = await connectCore({ socket, connectTimeoutMs: timeoutMs, callTimeoutMs: timeoutMs });
    clients.push(client);
    return client;
  }

  it('greets the core, skips events, and returns results and errors by id', async () => {
    const seen: string[] = [];
    await serve(seen);
    const client = await connect();
    expect(client.hello).toEqual(greeting);
    expect(client.socket).toBe(socket);
    await expect(client.call('status.get')).resolves.toMatchObject({ daemon: { pid: 42 } });
    await expect(client.call('nope')).rejects.toThrow('Unknown method.');
    client.close();
    expect(seen[0]).toBe(`hello {"bridge_version":${BRIDGE_VERSION}}`);
  });

  it('reports a missing socket as not running, and tryConnectCore as undefined', async () => {
    const missing = path.join(dir, 'missing.sock');
    await expect(connectCore({ socket: missing, connectTimeoutMs: 500 })).rejects.toBeInstanceOf(
      CoreNotRunningError
    );
    await expect(tryConnectCore({ socket: missing, connectTimeoutMs: 500 })).resolves.toBeUndefined();
  });

  it('reports a socket file nothing listens on as not running', async () => {
    await serve();
    const stale = path.join(dir, 'stale.sock');
    fs.renameSync(socket, stale);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(tryConnectCore({ socket: stale, connectTimeoutMs: 500 })).resolves.toBeUndefined();
  });

  it('resolves the socket from env and home', async () => {
    await serve();
    const client = await connectCore({ env: { AGENT_RELAY_CORE_SOCKET: socket }, home: '/nowhere' });
    clients.push(client);
    expect(client.socket).toBe(socket);
  });

  it('refuses a socket in a directory others can write to', async () => {
    await serve();
    fs.chmodSync(dir, 0o777);
    const error = await connectCore({ socket, connectTimeoutMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreUntrustedError);
    expect((error as CoreUntrustedError).reason).toBe('directory');
    expect((error as Error).message).toContain('only you can write to');
    // A refusal is never "not running".
    await expect(tryConnectCore({ socket, connectTimeoutMs: 500 })).rejects.toThrow('only you can write to');
  });

  it('refuses a socket others can use, which the core never binds', async () => {
    await serve();
    fs.chmodSync(socket, 0o666);
    const error = await connectCore({ socket, connectTimeoutMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreUntrustedError);
    expect((error as CoreUntrustedError).reason).toBe('socket');
    expect((error as Error).message).toContain('only you can use');
  });

  it('refuses a plain file in place of the socket', async () => {
    fs.writeFileSync(socket, '', { mode: 0o600 });
    await expect(connectCore({ socket, connectTimeoutMs: 500 })).rejects.toThrow('only you can use');
  });

  it("refuses a peer whose greeting is not the core's", async () => {
    await serve([], { ok: true });
    const error = await connectCore({ socket }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotACoreError);
    expect((error as Error).message).toContain('is not an Agent Relay core');
  });

  it('refuses a greeting with another bridge version, which a real core never sends', async () => {
    await serve([], { ...greeting, bridge_version: BRIDGE_VERSION + 1 });
    await expect(connectCore({ socket })).rejects.toBeInstanceOf(NotACoreError);
  });

  it('raises BridgeVersionMismatchError when the core refuses this bridge version', async () => {
    const coreMessage =
      'This Agent Relay core speaks bridge version 3; update the app or the core so they match.';
    await serve([], undefined);
    server!.removeAllListeners('connection');
    server!.on('connection', (connection) => {
      connection.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf8').split('\n')[0]) as Request;
        send(connection, {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32000,
            message: coreMessage,
            data: { kind: 'bridge_version_mismatch', retryable: false },
          },
        });
      });
    });
    const error = await connectCore({ socket }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeVersionMismatchError);
    const mismatch = error as BridgeVersionMismatchError;
    expect(mismatch.clientVersion).toBe(BRIDGE_VERSION);
    expect(mismatch.coreMessage).toBe(coreMessage);
    expect(mismatch.message).toContain('refused this client');
    expect(mismatch.message).toContain(coreMessage);
    expect(mismatch.cause).toBeInstanceOf(CoreRpcError);
  });

  it('surfaces the error kind, retryability and plan limit on CoreRpcError', async () => {
    const planLimit = { limit: 'agents', max: 3, current: 3, plan: 'intro' };
    await serve([], greeting, (request) =>
      request.method === 'agents.register'
        ? {
            error: {
              code: -32000,
              message: 'The plan is full.',
              data: { kind: 'plan_limit_exceeded', retryable: false, plan_limit: planLimit },
            },
          }
        : { error: { code: -32000, message: 'Busy.', data: { kind: 'busy', retryable: true } } }
    );
    const client = await connect();
    const full = (await client.call('agents.register').catch((e: unknown) => e)) as CoreRpcError;
    expect(full).toBeInstanceOf(CoreRpcError);
    expect(full).toBeInstanceOf(CoreBridgeError);
    expect(full).toMatchObject({
      code: 'rpc_error',
      rpcCode: -32000,
      kind: 'plan_limit_exceeded',
      retryable: false,
    });
    expect(full.planLimit).toEqual(planLimit);
    const busy = (await client.call('agents.end').catch((e: unknown) => e)) as CoreRpcError;
    expect(busy).toMatchObject({ kind: 'busy', retryable: true, planLimit: undefined });
    expect(full.reason).toBeUndefined();
    expect(busy.reason).toBeUndefined();
  });

  it('surfaces a refusal reason on CoreRpcError when the core gives one', async () => {
    const refused = (reason?: unknown) => ({
      error: {
        code: -32000,
        message: 'Refused.',
        data:
          reason === undefined
            ? { kind: 'refused', retryable: false }
            : { kind: 'refused', retryable: false, reason },
      },
    });
    await serve([], greeting, (request) => {
      if (request.method === 'spawn.invoke') return refused('not_owner');
      if (request.method === 'spawn.status') return refused('quota_exhausted');
      if (request.method === 'spawn.release') return refused(7);
      return refused();
    });
    const client = await connect();
    const rpc = (method: string) => client.call(method).catch((e: unknown) => e) as Promise<CoreRpcError>;
    const known = await rpc('spawn.invoke');
    expect(known).toBeInstanceOf(CoreRpcError);
    expect(known).toMatchObject({ kind: 'refused', retryable: false, reason: 'not_owner' });
    // A reason this client does not know yet is kept as the core sent it.
    expect((await rpc('spawn.status')).reason).toBe('quota_exhausted');
    // A refusal without a reason, or with a non-string one, has none.
    const bare = await rpc('spawn.targets');
    expect(bare.reason).toBeUndefined();
    expect(bare).toMatchObject({ kind: 'refused' });
    expect((await rpc('spawn.release')).reason).toBeUndefined();
  });

  it('delivers events to listeners and keeps reading when one throws', async () => {
    await serve([], greeting, (request, connection) => {
      if (request.method === 'status.get') return { result: { ok: true } };
      if (request.method !== 'subscribe') return undefined;
      send(connection, {
        jsonrpc: '2.0',
        method: 'event',
        params: { topic: 'status', seq: 7, data: { ok: 1 } },
      });
      // An unknown notification and a non-JSON line are ignored.
      send(connection, { jsonrpc: '2.0', method: 'later.notification', params: { x: 1 } });
      connection.write('not json\n');
      return { result: { topics: request.params.topics, status: { ok: 1 } } };
    });
    const client = await connect();
    const events: CoreEvent[] = [];
    client.onEvent(() => {
      throw new Error('listener failure');
    });
    const remove = client.onEvent((event) => events.push(event));
    await expect(client.subscribe(['status'])).resolves.toEqual({ topics: ['status'], status: { ok: 1 } });
    expect(events).toEqual([{ revision: 3 }, { topic: 'status', seq: 7, data: { ok: 1 } }]);
    remove();
    await expect(client.call('status.get')).resolves.toBeTruthy();
    expect(events).toHaveLength(2);
  });

  it('closes the connection on a reply line over the cap', async () => {
    await serve([], greeting, (request, connection) => {
      if (request.method !== 'big') return undefined;
      // Two chunks, neither newline-terminated until the line is already too long.
      const payload = 'x'.repeat(MAX_REPLY_BYTES);
      connection.write(`{"jsonrpc":"2.0","id":${request.id},"result":"${payload}"}\n`);
      return undefined;
    });
    const client = await connect(10_000);
    const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve));
    const error = await client.call('big').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreReplyTooLargeError);
    await expect(closed).resolves.toBeInstanceOf(CoreReplyTooLargeError);
    expect(client.closed).toBe(true);
    await expect(client.call('status.get')).rejects.toBeInstanceOf(CoreClosedError);
  }, 20_000);

  it('accepts a reply line exactly at the cap', async () => {
    await serve([], greeting, (request, connection) => {
      if (request.method !== 'big') return undefined;
      const frame = `{"jsonrpc":"2.0","id":${request.id},"result":""}`;
      const payload = 'y'.repeat(MAX_REPLY_BYTES - frame.length);
      connection.write(`{"jsonrpc":"2.0","id":${request.id},"result":"${payload}"}\n`);
      return undefined;
    });
    const client = await connect(10_000);
    const result = await client.call<string>('big');
    expect(result).toHaveLength(MAX_REPLY_BYTES - `{"jsonrpc":"2.0","id":2,"result":""}`.length);
  }, 20_000);

  it('refuses a request over the cap locally and keeps the connection', async () => {
    const seen: string[] = [];
    await serve(seen);
    const client = await connect();
    const error = await client
      .call('status.get', { blob: 'z'.repeat(MAX_REQUEST_BYTES) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreRequestTooLargeError);
    expect(seen).toEqual([`hello {"bridge_version":${BRIDGE_VERSION}}`]);
    // Multi-byte characters count as bytes.
    const wide = await client
      .call('status.get', { blob: 'é'.repeat(MAX_REQUEST_BYTES / 2) })
      .catch((e: unknown) => e);
    expect(wide).toBeInstanceOf(CoreRequestTooLargeError);
    await expect(client.call('status.get')).resolves.toBeTruthy();
  });

  it('times out a call with CoreTimeoutError and forgets it', async () => {
    let silentId = -1;
    await serve([], greeting, (request, connection) => {
      if (request.method === 'slow') {
        silentId = request.id;
        return undefined;
      }
      if (request.method === 'answer.late') {
        // The late answer to the timed-out call must be dropped.
        send(connection, { jsonrpc: '2.0', id: silentId, result: 'late' });
        return { result: 'ok' };
      }
      return undefined;
    });
    const client = await connect();
    const error = await client.call('slow', {}, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreTimeoutError);
    expect((error as CoreTimeoutError).method).toBe('slow');
    expect((error as Error).message).toBe('The Agent Relay core did not answer slow in time.');
    await expect(client.call('answer.late')).resolves.toBe('ok');
  });

  it('abandons a call on its signal and keeps the connection', async () => {
    await serve([], greeting, (request) => (request.method === 'status.get' ? { result: 1 } : undefined));
    const client = await connect();
    const controller = new AbortController();
    const call = client.call('slow', {}, { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(call).rejects.toThrow('stop');
    await expect(client.call('status.get')).resolves.toBe(1);
  });

  it('fails pending calls with CoreClosedError on close, and later calls too', async () => {
    await serve([], greeting, () => undefined);
    const client = await connect();
    const closes: (Error | undefined)[] = [];
    client.onClose((error) => closes.push(error));
    const pending = client.call('slow');
    client.close();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreClosedError);
    expect((error as Error).message).toBe('The Agent Relay core closed the connection.');
    await expect(client.call('status.get')).rejects.toBeInstanceOf(CoreClosedError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes).toEqual([undefined]);
  });

  it('reports the core closing the connection to onClose and pending calls', async () => {
    await serve([], greeting, (request, connection) => {
      if (request.method === 'daemon.shutdown') {
        send(connection, {
          jsonrpc: '2.0',
          method: 'event',
          params: { topic: 'shutdown', seq: 9, data: {} },
        });
        connection.end();
      }
      return undefined;
    });
    const client = await connect();
    const events: CoreEvent[] = [];
    client.onEvent((event) => events.push(event));
    const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve));
    await expect(client.call('daemon.shutdown')).rejects.toBeInstanceOf(CoreClosedError);
    await expect(closed).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({ topic: 'shutdown', seq: 9, data: {} });
  });

  it('closes through Symbol.asyncDispose', async () => {
    await serve();
    const client = await connect();
    await client[Symbol.asyncDispose]();
    expect(client.closed).toBe(true);
    await expect(client.call('status.get')).rejects.toBeInstanceOf(CoreClosedError);
  });

  it('closes when the connect signal aborts after connecting', async () => {
    await serve();
    const controller = new AbortController();
    const client = await connectCore({ socket, signal: controller.signal });
    clients.push(client);
    const closed = new Promise<Error | undefined>((resolve) => client.onClose(resolve));
    controller.abort();
    await closed;
    expect(client.closed).toBe(true);
  });

  it('does not connect with an aborted signal', async () => {
    await serve();
    const controller = new AbortController();
    controller.abort(new Error('never mind'));
    await expect(connectCore({ socket, signal: controller.signal })).rejects.toThrow('never mind');
  });
});
