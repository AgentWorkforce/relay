import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { action, defineNode, spawn } from './index.js';
import { startServeNode, type FleetLogger, type FleetTriggerSyncClient } from './serve-node.js';

/**
 * A fake node-ws server: captures frames the client sends and lets the test
 * drive replies/invokes, mirroring the engine's node-socket contract without any
 * network. Modeled on the relaycast NodeProviderClient conformance fake.
 */
class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.type === type);
  }

  lastRegister(): Record<string, unknown> {
    return this.sentOfType('node.register').at(-1)!;
  }
}

function acceptAll(register: Record<string, unknown>): Record<string, unknown> {
  const caps = (register.capabilities as { name: string; kind?: string }[]) ?? [];
  const provider = register.provider as { name: string; instance_id: string };
  return {
    v: 1,
    id: register.id,
    type: 'reply',
    ok: true,
    data: {
      provider,
      accepted_capabilities: caps.map((cap) => ({
        name: cap.name,
        kind: cap.kind ?? 'action',
        accepted: true,
      })),
      name: register.name,
    },
  };
}

const connection = { baseUrl: 'https://engine.test', nodeToken: 'nt_live_test', nodeId: 'node_a' };

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe('serveNode', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function socket(): MockWebSocket {
    return MockWebSocket.instances.at(-1)!;
  }

  it('registers the definition as a provider with action-kind capabilities', async () => {
    const node = defineNode({
      name: 'data-pipeline',
      capabilities: {
        'run-etl': action({ input: z.object({ date: z.string() }) }, async () => 'done'),
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });

    const sock = socket();
    const url = new URL(sock.url);
    expect(url.pathname).toBe('/v1/node/ws');
    expect(url.searchParams.get('token')).toBe('nt_live_test');

    sock.open();
    const register = sock.lastRegister();
    expect(register).toMatchObject({ type: 'node.register', name: 'data-pipeline', node_id: 'node_a' });
    expect(register.provider).toMatchObject({ name: 'data-pipeline' });
    expect(register.capabilities).toEqual([{ name: 'run-etl', kind: 'action' }]);

    sock.emit(acceptAll(register));
    await flush();
    await running.stop();
  });

  it('runs a handler and replies action.result with its output', async () => {
    const node = defineNode({
      name: 'p',
      capabilities: {
        'run-etl': action({ input: z.object({ date: z.string() }) }, async (input) => ({
          ran: (input as { date: string }).date,
        })),
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();

    sock.emit({
      v: 1,
      type: 'action.invoke',
      invocation_id: 'inv_1',
      action: 'run-etl',
      input: { date: '2026-07-09' },
    });
    await flush();

    const [result] = sock.sentOfType('action.result');
    expect(result).toMatchObject({ invocation_id: 'inv_1', output: { ran: '2026-07-09' } });
    await running.stop();
  });

  it('replies action.result with an error when the handler throws', async () => {
    const node = defineNode({
      name: 'p',
      capabilities: {
        'run-etl': action({}, async () => {
          throw new Error('boom');
        }),
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv_2', action: 'run-etl', input: {} });
    await flush();

    const [result] = sock.sentOfType('action.result');
    expect(result).toMatchObject({ invocation_id: 'inv_2', error: 'boom' });
    await running.stop();
  });

  it('sendMessage strips a leading # so a #channel address posts to the bare channel name', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'msg_1' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const node = defineNode({
      name: 'p',
      capabilities: {
        announce: action({}, async (_input, ctx) => {
          await ctx.relay.sendMessage({ to: '#general', text: 'shipped', from: 'reporter' });
          return 'ok';
        }),
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv_msg', action: 'announce', input: {} });
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    // `#general` normalizes to the bare channel name — not the literal `%23general`
    // that would 404 as channel_not_found.
    expect(url).toBe('https://engine.test/v1/channels/general/messages');

    const [result] = sock.sentOfType('action.result');
    expect(result).toMatchObject({ invocation_id: 'inv_msg', output: 'ok' });
    await running.stop();
  });

  it('delegates a spawn shadow to node.spawn with the harness flattened to top-level cli', async () => {
    const node = defineNode({
      name: 'p',
      capabilities: {
        'spawn:codex': spawn({ runtime: 'pty', command: 'codex' }),
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });
    const sock = socket();
    sock.open();
    const register = sock.lastRegister();
    // The spawn definition registers as an invokable (shadow) action.
    expect(register.capabilities).toEqual([{ name: 'spawn:codex', kind: 'action' }]);
    sock.emit(acceptAll(register));
    await flush();

    sock.emit({
      v: 1,
      type: 'action.invoke',
      invocation_id: 'inv_3',
      action: 'spawn:codex',
      input: { name: 'worker-a' },
    });
    await flush();

    const [nodeSpawn] = sock.sentOfType('node.spawn');
    expect(nodeSpawn).toBeTruthy();
    // The delegation carries `capability: 'codex'` (from the shadow name) so the
    // engine keys node capacity on `spawn:codex`, plus the executable `cli`.
    expect(nodeSpawn.input).toMatchObject({ name: 'worker-a', cli: 'codex', capability: 'codex' });
    // Reply so the delegating handler resolves and the invocation completes.
    sock.emit({ v: 1, id: nodeSpawn.id, type: 'reply', ok: true, data: { name: 'worker-a' } });
    await flush();
    await running.stop();
  });

  it('delegates with the shadow harness as capability even when the executable differs', async () => {
    // A `spawn:claude` shadow whose harness command is an arbitrary executable
    // (here `node`, as the E2E stub uses) must still delegate to `spawn:claude`
    // capacity — the capacity key comes from the shadow name, not the command.
    const node = defineNode({
      name: 'p',
      capabilities: {
        'spawn:claude': spawn({ runtime: 'pty', command: 'node', args: ['stub.cjs'] }),
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();

    sock.emit({
      v: 1,
      type: 'action.invoke',
      invocation_id: 'inv_shadow',
      action: 'spawn:claude',
      input: { name: 'worker-c' },
    });
    await flush();

    const [nodeSpawn] = sock.sentOfType('node.spawn');
    expect(nodeSpawn).toBeTruthy();
    expect(nodeSpawn.input).toMatchObject({ name: 'worker-c', cli: 'node', capability: 'claude' });
    sock.emit({ v: 1, id: nodeSpawn.id, type: 'reply', ok: true, data: { name: 'worker-c' } });
    await flush();
    await running.stop();
  });

  it('lets a spawn-prefixed action delegate to its resolved runtime instead of a shadow harness', async () => {
    const node = defineNode({
      name: 'p',
      capabilities: {
        'spawn:persona': action({}, async (_input, ctx) =>
          ctx.spawnAgent({
            agent: {
              name: 'persona-worker',
              runtime: 'pty',
              cli: 'codex',
              model: 'persona-model',
            },
          })
        ),
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();

    sock.emit({
      v: 1,
      type: 'action.invoke',
      invocation_id: 'inv_persona',
      action: 'spawn:persona',
      input: { persona: 'nango-integrations' },
    });
    await flush();

    const [nodeSpawn] = sock.sentOfType('node.spawn');
    expect(nodeSpawn).toBeTruthy();
    expect(nodeSpawn.input).toMatchObject({
      name: 'persona-worker',
      cli: 'codex',
      model: 'persona-model',
    });
    expect(nodeSpawn.input).not.toHaveProperty('capability');
    sock.emit({ v: 1, id: nodeSpawn.id, type: 'reply', ok: true, data: { name: 'persona-worker' } });
    await flush();
    await running.stop();
  });

  it('reconciles declared triggers with the injected client on registration', async () => {
    const node = defineNode({
      name: 'p',
      capabilities: {
        deploy: action({}, async () => 'ok'),
      },
      triggers: [{ type: 'message', channel: '#deploys', actionName: 'deploy' }],
    });
    const created: unknown[] = [];
    const triggers: FleetTriggerSyncClient = {
      list: async () => [],
      create: async (input) => {
        created.push(input);
      },
      update: async () => undefined,
      delete: async () => undefined,
    };
    const running = startServeNode({ definition: node, connection, reconnect: false, triggers });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();

    expect(created).toEqual([
      { channel: '#deploys', pattern: undefined, mention: undefined, actionName: 'deploy', enabled: true },
    ]);
    await running.stop();
  });

  describe('structured logging', () => {
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

    function loggingNode() {
      return defineNode({
        name: 'test-node',
        capabilities: {
          echo: action({ input: z.object({ value: z.string() }) }, async (input) => input),
          explode: action({}, async () => {
            throw new Error('boom');
          }),
        },
      });
    }

    it('logs each registered capability at debug and a registration summary at info', async () => {
      const { logger, entries } = recordingLogger();
      const running = startServeNode({ definition: loggingNode(), connection, reconnect: false, logger });
      const sock = socket();
      sock.open();
      sock.emit(acceptAll(sock.lastRegister()));
      await flush();

      const capabilities = entries.filter((entry) => entry.message.startsWith('Capability'));
      expect(capabilities.map((entry) => entry.extra?.capability)).toEqual(['echo', 'explode']);
      expect(capabilities.every((entry) => entry.level === 'debug')).toBe(true);
      expect(capabilities[0]?.extra).toMatchObject({ node: 'test-node', capability: 'echo', kind: 'action' });

      const summary = entries.find((entry) => entry.message.includes('with 2 capabilities'));
      expect(summary?.level).toBe('info');
      expect(summary?.extra).toMatchObject({ node: 'test-node', capabilities: 2 });

      await running.stop();
    });

    it('logs an action invocation and its completion with a duration', async () => {
      const { logger, entries } = recordingLogger();
      const running = startServeNode({ definition: loggingNode(), connection, reconnect: false, logger });
      const sock = socket();
      sock.open();
      sock.emit(acceptAll(sock.lastRegister()));
      await flush();

      sock.emit({
        v: 1,
        type: 'action.invoke',
        invocation_id: 'inv-1',
        action: 'echo',
        input: { value: 'hi' },
      });
      await flush();

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

      await running.stop();
    });

    it('logs a failed action as a warning carrying the error', async () => {
      const { logger, entries } = recordingLogger();
      const running = startServeNode({ definition: loggingNode(), connection, reconnect: false, logger });
      const sock = socket();
      sock.open();
      sock.emit(acceptAll(sock.lastRegister()));
      await flush();

      sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv-2', action: 'explode', input: {} });
      await flush();

      const failed = entries.find((entry) => entry.message === 'Action "explode" failed');
      expect(failed?.level).toBe('warn');
      expect(failed?.extra).toMatchObject({ action: 'explode', invocationId: 'inv-2', error: 'boom' });

      await running.stop();
    });
  });
});
