import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import { action, defineNode, onMessage } from './index.js';
import {
  buildNodeSupervision,
  readFleetSidecarStatus,
  serveNode,
  startServeNode,
  type FleetLogger,
  type FleetTriggerSyncClient,
  type FleetTriggerSyncTrigger,
} from './serve-node.js';

type ReceivedFrame = {
  v: number;
  type: string;
  request_id?: string;
  payload: unknown;
};

/**
 * A minimal in-process broker used to exercise the fleet node WS runtime.
 * Auto-acknowledges every request with an `ok` frame and records the frames it
 * receives so tests can assert on the registration handshake and handler results.
 */
class TestBroker {
  readonly server: WebSocketServer;
  readonly connections: WebSocket[] = [];
  readonly frames: ReceivedFrame[] = [];
  private onFrameListeners: Array<(frame: ReceivedFrame, socket: WebSocket) => void> = [];
  private onConnectionListeners: Array<(socket: WebSocket) => void> = [];

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on('connection', (socket) => {
      this.connections.push(socket);
      for (const listener of this.onConnectionListeners) listener(socket);
      socket.on('message', (data: RawData) => {
        const frame = parseFrame(data);
        if (!frame) return;
        this.frames.push(frame);
        for (const listener of this.onFrameListeners) listener(frame, socket);
        if (frame.request_id) {
          this.reply(socket, frame.request_id, resultFor(frame));
        }
      });
    });
  }

  static async start(): Promise<TestBroker> {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return new TestBroker(server);
  }

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  onFrame(listener: (frame: ReceivedFrame, socket: WebSocket) => void): void {
    this.onFrameListeners.push(listener);
  }

  onConnection(listener: (socket: WebSocket) => void): void {
    this.onConnectionListeners.push(listener);
  }

  reply(socket: WebSocket, requestId: string, result: unknown): void {
    socket.send(JSON.stringify({ v: 2, type: 'ok', request_id: requestId, payload: { result } }));
  }

  sendInvoke(socket: WebSocket, input: { invocation_id: string; name: string; input: unknown }): void {
    socket.send(
      JSON.stringify({
        v: 2,
        type: 'invoke_handler',
        request_id: `broker_${input.invocation_id}`,
        payload: input,
      })
    );
  }

  framesOfType(type: string): ReceivedFrame[] {
    return this.frames.filter((frame) => frame.type === type);
  }

  async close(): Promise<void> {
    for (const socket of this.connections) {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function parseFrame(data: RawData): ReceivedFrame | null {
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString();
    return JSON.parse(text) as ReceivedFrame;
  } catch {
    return null;
  }
}

function resultFor(frame: ReceivedFrame): unknown {
  if (frame.type === 'hello') {
    return { broker_version: 'test', protocol_version: 2 };
  }
  return { ok: true };
}

function buildNode() {
  return defineNode({
    name: 'test-node',
    maxAgents: 2,
    capabilities: {
      echo: action({ input: z.object({ value: z.string() }) }, async (input: { value: string }) => ({
        echoed: input.value,
      })),
      explode: action({}, async () => {
        throw new Error('boom');
      }),
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let broker: TestBroker;

beforeEach(async () => {
  broker = await TestBroker.start();
});

afterEach(async () => {
  await broker.close();
});

describe('serveNode registration', () => {
  it('performs the hello/register_node/register_handlers handshake', async () => {
    const node = buildNode();
    const registered = new Promise<void>((resolve) => {
      const running = startServeNode({
        definition: node,
        connection: { url: broker.url },
        reconnect: false,
        onRegistered: () => resolve(),
      });
      void running.done;
    });

    await registered;
    await waitFor(() => broker.framesOfType('register_handlers').length > 0);

    const hello = broker.framesOfType('hello')[0];
    expect(hello?.payload).toMatchObject({ client_name: '@agent-relay/fleet' });

    const registerNode = broker.framesOfType('register_node')[0];
    expect(registerNode?.payload).toMatchObject({
      manifest: { name: 'test-node', max_agents: 2 },
    });

    const registerHandlers = broker.framesOfType('register_handlers')[0];
    expect(registerHandlers?.payload).toMatchObject({ names: ['echo', 'explode'] });
  });
});

describe('serveNode invoke dispatch', () => {
  it('returns a handler_result with output on success', async () => {
    const node = buildNode();
    const controller = new AbortController();
    let socket: WebSocket | undefined;
    broker.onConnection((s) => {
      socket = s;
    });

    const done = serveNode({
      definition: node,
      connection: { url: broker.url },
      reconnect: false,
      signal: controller.signal,
      onRegistered: () => {
        broker.sendInvoke(socket!, { invocation_id: 'inv-1', name: 'echo', input: { value: 'hi' } });
      },
    });

    await waitFor(() => broker.framesOfType('handler_result').length > 0);
    const result = broker.framesOfType('handler_result')[0];
    expect(result?.payload).toEqual({ invocation_id: 'inv-1', output: { echoed: 'hi' } });

    controller.abort();
    await done;
  });

  it('returns a handler_result with error when the handler throws', async () => {
    const node = buildNode();
    const controller = new AbortController();
    let socket: WebSocket | undefined;
    broker.onConnection((s) => {
      socket = s;
    });

    const done = serveNode({
      definition: node,
      connection: { url: broker.url },
      reconnect: false,
      signal: controller.signal,
      onRegistered: () => {
        broker.sendInvoke(socket!, { invocation_id: 'inv-2', name: 'explode', input: {} });
      },
    });

    await waitFor(() => broker.framesOfType('handler_result').length > 0);
    const result = broker.framesOfType('handler_result')[0];
    expect(result?.payload).toMatchObject({ invocation_id: 'inv-2', error: 'boom' });

    controller.abort();
    await done;
  });
});

describe('serveNode logging', () => {
  function recordingLogger() {
    const entries: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = [];
    const record = (level: string) => (message: string, extra?: Record<string, unknown>) => {
      entries.push({ level, message, ...(extra ? { extra } : {}) });
    };
    const logger: FleetLogger = {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
    return { logger, entries };
  }

  it('logs each registered capability and a registration summary', async () => {
    const { logger, entries } = recordingLogger();
    const controller = new AbortController();
    const registered = new Promise<void>((resolve) => {
      void serveNode({
        definition: buildNode(),
        connection: { url: broker.url },
        reconnect: false,
        signal: controller.signal,
        logger,
        onRegistered: () => resolve(),
      });
    });

    await registered;
    await waitFor(() => entries.some((entry) => entry.message.includes('registered with')));

    const capabilities = entries.filter((entry) => entry.message.startsWith('Capability'));
    expect(capabilities.map((entry) => entry.extra?.capability)).toEqual(['echo', 'explode']);
    expect(capabilities.every((entry) => entry.level === 'debug')).toBe(true);
    expect(capabilities[0]?.extra).toMatchObject({ capability: 'echo', kind: 'action' });

    const summary = entries.find((entry) => entry.message.includes('registered with 2 capabilities'));
    expect(summary?.level).toBe('info');
    expect(summary?.extra).toMatchObject({ node: 'test-node', capabilities: 2 });

    controller.abort();
  });

  it('logs an action invocation and its completion with a duration', async () => {
    const { logger, entries } = recordingLogger();
    const controller = new AbortController();
    let socket: WebSocket | undefined;
    broker.onConnection((s) => {
      socket = s;
    });

    const done = serveNode({
      definition: buildNode(),
      connection: { url: broker.url },
      reconnect: false,
      signal: controller.signal,
      logger,
      onRegistered: () => {
        broker.sendInvoke(socket!, { invocation_id: 'inv-1', name: 'echo', input: { value: 'hi' } });
      },
    });

    await waitFor(() => entries.some((entry) => entry.message.includes('completed')));
    const invoked = entries.find((entry) => entry.message === 'Action "echo" invoked');
    expect(invoked?.level).toBe('info');
    expect(invoked?.extra).toMatchObject({
      node: 'test-node',
      action: 'echo',
      kind: 'action',
      invocationId: 'inv-1',
    });
    const completed = entries.find((entry) => entry.message === 'Action "echo" completed');
    expect(completed?.level).toBe('info');
    expect(completed?.extra).toMatchObject({ node: 'test-node', action: 'echo', invocationId: 'inv-1' });
    expect(typeof completed?.extra?.ms).toBe('number');

    controller.abort();
    await done;
  });

  it('logs a failed action as a warning carrying the error', async () => {
    const { logger, entries } = recordingLogger();
    const controller = new AbortController();
    let socket: WebSocket | undefined;
    broker.onConnection((s) => {
      socket = s;
    });

    const done = serveNode({
      definition: buildNode(),
      connection: { url: broker.url },
      reconnect: false,
      signal: controller.signal,
      logger,
      onRegistered: () => {
        broker.sendInvoke(socket!, { invocation_id: 'inv-2', name: 'explode', input: {} });
      },
    });

    await waitFor(() => entries.some((entry) => entry.message.includes('failed')));
    const failed = entries.find((entry) => entry.message === 'Action "explode" failed');
    expect(failed?.level).toBe('warn');
    expect(failed?.extra).toMatchObject({ action: 'explode', invocationId: 'inv-2', error: 'boom' });

    controller.abort();
    await done;
  });
});

describe('serveNode status file', () => {
  it('writes connected status on registration and disconnected status on stop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-status-'));
    const statusPath = path.join(dir, 'fleet-node.json');
    try {
      const node = buildNode();
      let registeredStop: (() => Promise<void>) | undefined;
      const registered = new Promise<void>((resolve) => {
        const running = startServeNode({
          definition: node,
          connection: { url: broker.url },
          reconnect: false,
          statusPath,
          onRegistered: () => resolve(),
        });
        void running.done;
        registeredStop = running.stop;
      });

      await registered;
      const connectedStatus = readFleetSidecarStatus(statusPath);
      expect(connectedStatus).toMatchObject({ node: 'test-node', connected: true });
      expect(connectedStatus?.handlers).toEqual(['echo', 'explode']);

      await registeredStop?.();
      const disconnectedStatus = readFleetSidecarStatus(statusPath);
      expect(disconnectedStatus).toMatchObject({ connected: false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('serveNode reconnect', () => {
  it('reconnects after the broker drops the connection', async () => {
    const node = buildNode();
    let connectionCount = 0;
    broker.onConnection((socket) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        // Drop the first connection once it is established to force a reconnect.
        setTimeout(() => socket.terminate(), 20);
      }
    });

    const running = startServeNode({
      definition: node,
      connection: { url: broker.url },
      reconnect: true,
    });

    await waitFor(() => connectionCount >= 2, 8_000);
    expect(connectionCount).toBeGreaterThanOrEqual(2);

    await running.stop();
  });
});

describe('buildNodeSupervision', () => {
  it('filters the environment to the allowlist', () => {
    const supervision = buildNodeSupervision({
      argv: ['node', 'serve'],
      cwd: '/tmp/project',
      env: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        RELAY_WORKSPACE_KEY: 'wk_123',
        SECRET_TOKEN: 'nope',
        RANDOM_VAR: 'nope',
      },
    });

    expect(supervision.argv).toEqual(['node', 'serve']);
    expect(supervision.cwd).toBe('/tmp/project');
    expect(supervision.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      RELAY_WORKSPACE_KEY: 'wk_123',
    });
    expect(supervision.env).not.toHaveProperty('SECRET_TOKEN');
    expect(supervision.env).not.toHaveProperty('RANDOM_VAR');
  });
});

describe('serveNode trigger sync', () => {
  function triggeredNode() {
    return defineNode({
      name: 'triggered-node',
      capabilities: {
        deploy: action({ input: z.object({}) }, async () => ({ ok: true })),
      },
      triggers: [onMessage({ channel: '#deploys', match: /[Ss]hip/, mention: true }, 'deploy')],
    });
  }

  function fakeClient(existing: FleetTriggerSyncTrigger[]) {
    const calls = {
      create: [] as unknown[],
      update: [] as Array<{ id: string; input: unknown }>,
      delete: [] as string[],
      listed: 0,
    };
    const client: FleetTriggerSyncClient = {
      list: async () => {
        calls.listed += 1;
        return existing;
      },
      create: async (input) => {
        calls.create.push(input);
        return {};
      },
      update: async (id, input) => {
        calls.update.push({ id, input });
        return {};
      },
      delete: async (id) => {
        calls.delete.push(id);
        return {};
      },
    };
    return { client, calls };
  }

  async function runWithClient(node: ReturnType<typeof triggeredNode>, triggers?: FleetTriggerSyncClient) {
    const controller = new AbortController();
    const synced = new Promise<void>((resolve) => {
      void serveNode({
        definition: node,
        connection: { url: broker.url },
        reconnect: false,
        signal: controller.signal,
        ...(triggers ? { triggers } : {}),
        // log fires after syncTriggers completes.
        log: () => resolve(),
      });
    });
    await synced;
    controller.abort();
  }

  it('creates a trigger that does not yet exist', async () => {
    const { client, calls } = fakeClient([]);
    await runWithClient(triggeredNode(), client);
    expect(calls.listed).toBe(1);
    expect(calls.create).toEqual([
      { channel: '#deploys', pattern: '[Ss]hip', mention: true, actionName: 'deploy', enabled: true },
    ]);
    expect(calls.update).toEqual([]);
    expect(calls.delete).toEqual([]);
  });

  it('updates a matching trigger whose fields differ', async () => {
    const { client, calls } = fakeClient([
      {
        id: 'trg_1',
        channel: '#deploys',
        pattern: '[Ss]hip',
        mention: true,
        actionName: 'deploy',
        enabled: false,
      },
    ]);
    await runWithClient(triggeredNode(), client);
    expect(calls.create).toEqual([]);
    expect(calls.update).toEqual([
      {
        id: 'trg_1',
        input: {
          channel: '#deploys',
          pattern: '[Ss]hip',
          mention: true,
          actionName: 'deploy',
          enabled: true,
        },
      },
    ]);
    expect(calls.delete).toEqual([]);
  });

  it('deletes duplicate triggers and keeps a single canonical one', async () => {
    const { client, calls } = fakeClient([
      {
        id: 'trg_primary',
        channel: '#deploys',
        pattern: '[Ss]hip',
        mention: true,
        actionName: 'deploy',
        enabled: true,
      },
      {
        id: 'trg_dupe',
        channel: '#deploys',
        pattern: '[Ss]hip',
        mention: true,
        actionName: 'deploy',
        enabled: true,
      },
    ]);
    await runWithClient(triggeredNode(), client);
    expect(calls.create).toEqual([]);
    // Primary already matches → no update.
    expect(calls.update).toEqual([]);
    expect(calls.delete).toEqual(['trg_dupe']);
  });

  it('skips sync entirely when no trigger client is injected', async () => {
    // No triggers client passed; sync must be a no-op and registration completes.
    await runWithClient(triggeredNode(), undefined);
    // Nothing to assert beyond completing without error; reaching here is success.
    expect(true).toBe(true);
  });
});
