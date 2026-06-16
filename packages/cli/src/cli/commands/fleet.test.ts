import { once } from 'node:events';
import path from 'node:path';

import { WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { action, defineNode, onMessage } from '@agent-relay/fleet';

import { loadNodeDefinition } from './fleet.js';
import { startFleetSidecar, serveFleetSidecar } from '../lib/fleet-sidecar.js';

describe('fleet command support', () => {
  it('loads the example TS node file', async () => {
    const node = await loadNodeDefinition(path.resolve(process.cwd(), 'examples/relay-node.ts'));

    expect(node.name).toBe('local-builder');
    expect(Object.keys(node.capabilities)).toContain('spawn:codex');
  });

  it('registers a served node and dispatches invoke_handler over a stub broker', async () => {
    const node = defineNode({
      name: 'stub-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
    });
    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    let registeredManifest: unknown;
    const handlerResult = new Promise<unknown>((resolve) => {
      broker.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const frame = JSON.parse(raw.toString()) as {
            type: string;
            request_id?: string;
            payload: Record<string, unknown>;
          };
          if (frame.type === 'register_node') {
            registeredManifest = frame.payload.manifest;
          }
          if (frame.request_id) {
            ws.send(
              JSON.stringify({
                v: 2,
                type: 'ok',
                request_id: frame.request_id,
                payload: { result: { ok: true } },
              })
            );
          }
          if (frame.type === 'register_handlers') {
            ws.send(
              JSON.stringify({
                v: 2,
                type: 'invoke_handler',
                payload: {
                  invocation_id: 'inv_1',
                  name: 'echo',
                  input: { text: 'hello' },
                },
              })
            );
          }
          if (frame.type === 'handler_result') {
            resolve(frame.payload);
            ws.close();
          }
        });
      });
    });

    await serveFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
    });

    expect(registeredManifest).toMatchObject({
      name: 'stub-node',
      capabilities: [{ name: 'echo', kind: 'action' }],
    });
    await expect(handlerResult).resolves.toEqual({
      invocation_id: 'inv_1',
      output: { echoed: 'hello' },
    });
    broker.close();
  });

  it('deregisters a node before a clean shutdown closes the websocket', async () => {
    const node = defineNode({
      name: 'shutdown-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
    });
    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    const frameTypes: string[] = [];
    const running = startFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
    });

    broker.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          type: string;
          request_id?: string;
          payload: Record<string, unknown>;
        };
        frameTypes.push(frame.type);
        if (frame.request_id) {
          ws.send(
            JSON.stringify({
              v: 2,
              type: 'ok',
              request_id: frame.request_id,
              payload: { result: { ok: true } },
            })
          );
        }
        if (frame.type === 'register_handlers') {
          void running.stop();
        }
      });
    });

    await running.done;

    expect(frameTypes).toEqual(['hello', 'register_node', 'register_handlers', 'deregister_node']);
    broker.close();
  });

  it('keeps trigger sync idempotent across repeated node registrations', async () => {
    vi.resetModules();

    const triggerCreate = vi.fn(async (input: unknown) => input);
    const triggerUpdate = vi.fn(async (input: unknown) => input);
    const triggerDelete = vi.fn(async () => undefined);
    const triggerList = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'trigger-1',
          actionName: 'echo',
          channel: '#general',
          pattern: 'hello',
          mention: true,
          enabled: true,
        },
      ]);

    vi.doMock('@agent-relay/sdk', () => ({
      AgentRelay: vi.fn(function () {
        return {
          triggers: {
            list: triggerList,
            create: triggerCreate,
            update: triggerUpdate,
            delete: triggerDelete,
          },
        };
      }),
    }));

    const { serveFleetSidecar: mockedServeFleetSidecar } = await import('../lib/fleet-sidecar.js');
    const node = defineNode({
      name: 'idempotent-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
      triggers: [onMessage({ channel: '#general', match: /hello/, mention: true }, 'echo')],
    });

    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    let connectionCount = 0;
    broker.on('connection', (ws) => {
      connectionCount += 1;
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; request_id?: string };
        if (frame.request_id) {
          ws.send(
            JSON.stringify({
              v: 2,
              type: 'ok',
              request_id: frame.request_id,
              payload: { result: { ok: true } },
            })
          );
        }
        if (frame.type === 'register_handlers') {
          setTimeout(() => ws.close(), 25);
        }
      });
    });

    await mockedServeFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
      workspaceKey: 'rk_live_test',
    });

    await mockedServeFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
      workspaceKey: 'rk_live_test',
    });

    expect(connectionCount).toBe(2);
    expect(triggerCreate).toHaveBeenCalledTimes(1);
    expect(triggerUpdate).not.toHaveBeenCalled();
    expect(triggerDelete).not.toHaveBeenCalled();
    broker.close();
  });

  it('re-enables a disabled matching trigger instead of creating a duplicate', async () => {
    vi.resetModules();

    const triggerCreate = vi.fn(async (input: unknown) => input);
    const triggerUpdate = vi.fn(async (input: unknown) => input);
    const triggerDelete = vi.fn(async () => undefined);
    const triggerList = vi.fn().mockResolvedValueOnce([
      {
        id: 'trigger-1',
        actionName: 'echo',
        channel: '#general',
        pattern: 'hello',
        mention: true,
        enabled: false,
      },
    ]);

    vi.doMock('@agent-relay/sdk', () => ({
      AgentRelay: vi.fn(function () {
        return {
          triggers: {
            list: triggerList,
            create: triggerCreate,
            update: triggerUpdate,
            delete: triggerDelete,
          },
        };
      }),
    }));

    const { serveFleetSidecar: mockedServeFleetSidecar } = await import('../lib/fleet-sidecar.js');
    const node = defineNode({
      name: 'reenable-node',
      capabilities: {
        echo: action({ input: z.object({ text: z.string() }) }, async (input) => ({ echoed: input.text })),
      },
      triggers: [onMessage({ channel: '#general', match: /hello/, mention: true }, 'echo')],
    });

    const broker = new WebSocketServer({ port: 0 });
    await once(broker, 'listening');
    const address = broker.address();
    if (!address || typeof address === 'string') {
      throw new Error('stub broker did not bind to a TCP port');
    }

    broker.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; request_id?: string };
        if (frame.request_id) {
          ws.send(
            JSON.stringify({
              v: 2,
              type: 'ok',
              request_id: frame.request_id,
              payload: { result: { ok: true } },
            })
          );
        }
        if (frame.type === 'register_handlers') {
          ws.close();
        }
      });
    });

    await mockedServeFleetSidecar({
      definition: node,
      connection: { url: `http://127.0.0.1:${address.port}` },
      reconnect: false,
      workspaceKey: 'rk_live_test',
    });

    expect(triggerList).toHaveBeenCalledTimes(1);
    expect(triggerCreate).not.toHaveBeenCalled();
    expect(triggerUpdate).toHaveBeenCalledWith('trigger-1', {
      channel: '#general',
      pattern: 'hello',
      mention: true,
      actionName: 'echo',
      enabled: true,
    });
    expect(triggerDelete).not.toHaveBeenCalled();
    broker.close();
  });
});
