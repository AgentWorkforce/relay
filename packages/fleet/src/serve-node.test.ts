import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { action, defineNode, spawn } from './index.js';
import {
  startServeNode,
  waitForDelegatedSpawn,
  type FleetLogger,
  type FleetTriggerSyncClient,
} from './serve-node.js';

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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function delegateForConfirmation(verifyReady = true, signal?: AbortSignal) {
    const definition = defineNode({
      name: 'p',
      capabilities: {
        'spawn:pool': spawn({ runtime: 'pty', command: 'node' }, { verifyReady }),
      },
    });
    const running = startServeNode({ definition, connection, reconnect: false, signal });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();
    sock.emit({
      v: 1,
      type: 'action.invoke',
      invocation_id: 'outer',
      action: 'spawn:pool',
      input: { name: 'worker' },
    });
    await flush();
    const [delegation] = sock.sentOfType('node.spawn');
    return { running, sock, delegation };
  }

  it.each([true, false])('requires confirmation only when verifyReady=%s', async (verifyReady) => {
    const fetchMock = vi.fn(async () => Response.json({}, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { running, sock, delegation } = await delegateForConfirmation(verifyReady);
    sock.emit({
      v: 1,
      id: delegation.id,
      type: 'reply',
      ok: true,
      data: { invocation_id: 'child', status: 'dispatched' },
    });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    const result = sock.sentOfType('action.result')[0]!;
    if (verifyReady) expect(result.error).toContain('engine must support node-owned spawn status reads');
    else {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.output).toMatchObject({
        placement: { invocation_id: 'child' },
        ready: false,
        readiness: 'unverified',
      });
      expect(delegation.input).toMatchObject({ verify_ready: false });
    }
    await running.stop();
  });

  it.each([429, 503])('releases HTTP %s response bodies before retrying confirmation', async (status) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const overload = new Response('retry later', { status });
    const cancel = vi.spyOn(overload.body!, 'cancel');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(overload)
      .mockResolvedValueOnce(
        Response.json({ data: { status: 'completed', output: { spawned: true, ready: true } } })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { running, sock, delegation } = await delegateForConfirmation();
    sock.emit({ v: 1, id: delegation.id, type: 'reply', ok: true, data: { invocation_id: 'child' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sock.sentOfType('action.result')[0]?.output).toMatchObject({ ready: true });
    await running.stop();
  });

  it('rejects a missing delegated invocation ID without polling', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { running, sock, delegation } = await delegateForConfirmation();
    sock.emit({ v: 1, id: delegation.id, type: 'reply', ok: true, data: {} });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    expect(sock.sentOfType('action.result')[0]?.error).toContain('spawn_confirmation_missing');
    expect(fetchMock).not.toHaveBeenCalled();
    await running.stop();
  });

  it.each(['external', 'deadline'])(
    'reports actionable child context after %s interruption',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      const nativeTimeout = AbortSignal.timeout;
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        if (ms !== 130000) return nativeTimeout(ms);
        if (kind === 'deadline') setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ data: { status: 'dispatched' } }))
      );
      const result = waitForDelegatedSpawn(
        {
          definition: defineNode({ name: 'p', capabilities: { ping: action({}, async () => 'ok') } }),
          connection,
          signal: kind === 'external' ? controller.signal : undefined,
        },
        { invocation_id: 'child' }
      );
      const rejected = expect(result).rejects.toThrow('spawn_confirmation_interrupted: child');
      await vi.advanceTimersByTimeAsync(0);
      if (kind === 'external') controller.abort();
      await vi.advanceTimersByTimeAsync(kind === 'deadline' ? 130000 : 0);
      await rejected;
    }
  );

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

  it('serializes only placement-safe repo keys and never node-local paths', async () => {
    const factoryPath = resolve('private-checkouts', 'factory');
    const relayPath = resolve('private-checkouts', 'relay');
    const node = defineNode({
      name: 'repo-builder',
      capabilities: { ping: async () => 'pong' },
      tags: ['arm64', 'repo:stale/manual-tag'],
      repoPaths: {
        'AgentWorkforce/relay': relayPath,
        'AgentWorkforce/factory': factoryPath,
      },
    });
    const running = startServeNode({ definition: node, connection, reconnect: false });

    const sock = socket();
    sock.open();
    const register = sock.lastRegister();
    expect(register.tags).toEqual(['arm64', 'repo:AgentWorkforce/factory', 'repo:AgentWorkforce/relay']);
    expect(register).not.toHaveProperty('repoPaths');
    expect(register).not.toHaveProperty('repo_paths');
    const serialized = JSON.stringify(register);
    expect(serialized).not.toContain(factoryPath);
    expect(serialized).not.toContain(relayPath);

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

  it.each(['completed', 'failed'] as const)(
    'waits for the delegated broker result before reporting %s',
    async (status) => {
      let respond!: (response: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const definition = defineNode({
        name: 'p',
        capabilities: { 'spawn:pool': spawn({ runtime: 'pty', command: 'node' }) },
      });
      const running = startServeNode({ definition, connection, reconnect: false });
      const sock = socket();
      sock.open();
      sock.emit(acceptAll(sock.lastRegister()));
      await flush();
      sock.emit({
        v: 1,
        type: 'action.invoke',
        invocation_id: 'outer',
        action: 'spawn:pool',
        input: { name: 'worker' },
      });
      await flush();
      const [delegation] = sock.sentOfType('node.spawn');
      sock.emit({ v: 1, id: delegation.id, type: 'reply', ok: true, data: { invocation_id: 'child' } });
      await flush();
      expect(sock.sentOfType('action.result')).toHaveLength(0);
      expect(delegation.input).toMatchObject({ verify_ready: true });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://engine.test/v1/actions/spawn/invocations/child',
        expect.objectContaining({
          headers: { authorization: 'Bearer nt_live_test' },
          signal: expect.any(AbortSignal),
        })
      );
      respond(
        Response.json({
          ok: true,
          data: {
            status,
            output: status === 'completed' ? { spawned: true, ready: true, name: 'worker' } : null,
            error: status === 'failed' ? 'spawn_failed: unsupported session resume' : null,
          },
        })
      );
      await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
      const [result] = sock.sentOfType('action.result');
      if (status === 'completed')
        expect(result.output).toMatchObject({ spawned: true, ready: true, name: 'worker' });
      else expect(result.error).toContain('unsupported session resume');
      await running.stop();
    }
  );

  it.each([
    {
      data: { status: 'completed', output: { spawned: true } },
      http: 200,
      error: 'spawn_readiness_unconfirmed',
    },
    { data: { status: 'cancelled' }, http: 200, error: 'cancelled' },
    { data: { status: 'unknown' }, http: 200, error: 'spawn_confirmation_invalid' },
    { data: {}, http: 403, error: 'engine must support node-owned spawn status reads' },
  ])('rejects an unproven delegated result: $error', async ({ data, http, error }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data }, { status: http }))
    );
    const definition = defineNode({
      name: 'p',
      capabilities: { 'spawn:pool': spawn({ runtime: 'pty', command: 'node' }) },
    });
    const running = startServeNode({ definition, connection, reconnect: false });
    const sock = socket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await flush();
    sock.emit({
      v: 1,
      type: 'action.invoke',
      invocation_id: 'outer',
      action: 'spawn:pool',
      input: { name: 'worker' },
    });
    await flush();
    const [delegation] = sock.sentOfType('node.spawn');
    sock.emit({ v: 1, id: delegation.id, type: 'reply', ok: true, data: { invocation_id: 'child' } });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    expect(sock.sentOfType('action.result')[0]?.error).toContain(error);
    await running.stop();
  });

  it('delegates a spawn shadow to node.spawn with the harness flattened to top-level cli', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: { status: 'completed', output: { spawned: true, ready: true, name: 'worker-a' } },
        })
      )
    );
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
      input: {
        name: 'worker-a',
        task: 'Implement fleet metadata',
        worker_cwd: '/srv/relay',
        organization: 'AgentWorkforce',
        project: 'relay',
        workstream: 'fleet-metadata',
        role: 'implementer',
      },
    });
    await flush();

    const [nodeSpawn] = sock.sentOfType('node.spawn');
    expect(nodeSpawn).toBeTruthy();
    // The delegation carries `capability: 'codex'` (from the shadow name) so the
    // engine keys node capacity on `spawn:codex`, plus the executable `cli`.
    expect(nodeSpawn.input).toMatchObject({
      name: 'worker-a',
      cli: 'codex',
      capability: 'codex',
      cwd: '/srv/relay',
      metadata: {
        organization: 'AgentWorkforce',
        project: 'relay',
        workstream: 'fleet-metadata',
        role: 'implementer',
        objective: 'Implement fleet metadata',
      },
    });
    // Reply so the delegating handler resolves and the invocation completes.
    sock.emit({ v: 1, id: nodeSpawn.id, type: 'reply', ok: true, data: { invocation_id: 'child-a' } });
    await vi.waitFor(() =>
      expect(sock.sentOfType('action.result')[0]?.output).toMatchObject({ ready: true })
    );
    await running.stop();
  });

  it('delegates with the shadow harness as capability even when the executable differs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: { status: 'completed', output: { spawned: true, ready: true, name: 'worker-c' } },
        })
      )
    );
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
    sock.emit({ v: 1, id: nodeSpawn.id, type: 'reply', ok: true, data: { invocation_id: 'child-c' } });
    await vi.waitFor(() =>
      expect(sock.sentOfType('action.result')[0]?.output).toMatchObject({ ready: true })
    );
    await running.stop();
  });

  it('lets a spawn-prefixed action delegate to its resolved runtime instead of a shadow harness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: { status: 'completed', output: { spawned: true, ready: true, name: 'persona-worker' } },
        })
      )
    );
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
    sock.emit({ v: 1, id: nodeSpawn.id, type: 'reply', ok: true, data: { invocation_id: 'child-persona' } });
    await vi.waitFor(() =>
      expect(sock.sentOfType('action.result')[0]?.output).toMatchObject({ ready: true })
    );
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
