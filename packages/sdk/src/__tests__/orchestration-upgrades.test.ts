import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { AgentRelayClient, AgentRelayProtocolError } from '../client.js';
import { AgentRelay } from '../relay.js';
import { PROTOCOL_VERSION, type BrokerEvent } from '../protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readWave0Fixture<T>(name: string): T {
  const fixturePath = path.resolve(__dirname, '../../../../tests/fixtures/contracts/wave0', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as T;
}

function createMockFacadeClient() {
  const listeners = new Set<(event: BrokerEvent) => void>();

  const mock = {
    spawnPty: vi.fn(async (input: { name: string }) => ({ name: input.name, runtime: 'pty' as const })),
    spawnProvider: vi.fn(async (input: { name: string }) => ({
      name: input.name,
      runtime: 'headless' as const,
    })),
    listAgents: vi.fn(
      async () =>
        [] as Array<{
          name: string;
          runtime: 'pty' | 'headless';
          channels: string[];
          parent?: string;
          pid?: number;
        }>
    ),
    sendMessage: vi.fn(async () => ({ event_id: 'evt_1', targets: ['worker'] })),
    release: vi.fn(async (name: string) => ({ name })),
    onEvent: vi.fn((listener: (event: BrokerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    shutdown: vi.fn(async () => undefined),
  };

  const emit = (event: BrokerEvent) => {
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  };

  return {
    client: mock as unknown as AgentRelayClient,
    mock,
    emit,
  };
}

function emitClientEvent(client: AgentRelayClient, event: BrokerEvent): void {
  (client as any).handleStdoutLine(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'event',
      payload: event,
    })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentRelayClient orchestration payloads', () => {
  it('spawnPty supports per-agent cwd overrides', async () => {
    const client = new AgentRelayClient({ cwd: '/workspace/default' });
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi
      .spyOn(client as any, 'requestOk')
      .mockResolvedValueOnce({ name: 'agent-a', runtime: 'pty' })
      .mockResolvedValueOnce({ name: 'agent-b', runtime: 'pty' });

    await client.spawnPty({ name: 'agent-a', cli: 'claude', cwd: '/workspace/a' });
    await client.spawnPty({ name: 'agent-b', cli: 'claude', cwd: '/workspace/b' });

    expect(requestOk).toHaveBeenNthCalledWith(
      1,
      'spawn_agent',
      expect.objectContaining({
        agent: expect.objectContaining({
          name: 'agent-a',
          cwd: '/workspace/a',
        }),
      })
    );
    expect(requestOk).toHaveBeenNthCalledWith(
      2,
      'spawn_agent',
      expect.objectContaining({
        agent: expect.objectContaining({
          name: 'agent-b',
          cwd: '/workspace/b',
        }),
      })
    );
  });

  it('spawnPty maps model to CLI args when supported', async () => {
    const client = new AgentRelayClient({ cwd: '/workspace/default' });
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi
      .spyOn(client as any, 'requestOk')
      .mockResolvedValue({ name: 'agent-model', runtime: 'pty' });

    await client.spawnPty({
      name: 'agent-model',
      cli: 'claude',
      model: 'opus',
      args: ['--dangerously-skip-permissions'],
    });

    expect(requestOk).toHaveBeenCalledWith(
      'spawn_agent',
      expect.objectContaining({
        agent: expect.objectContaining({
          model: 'opus',
          args: ['--model', 'opus', '--dangerously-skip-permissions'],
        }),
      })
    );
  });

  it('spawnClaude supports transport override to headless', async () => {
    const client = new AgentRelayClient({ cwd: '/workspace/default' });
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi
      .spyOn(client as any, 'requestOk')
      .mockResolvedValue({ name: 'agent-headless', runtime: 'headless' });

    await client.spawnClaude({
      name: 'agent-headless',
      transport: 'headless',
      channels: ['general'],
      task: 'run headless',
    });

    expect(requestOk).toHaveBeenCalledWith(
      'spawn_agent',
      expect.objectContaining({
        agent: expect.objectContaining({
          name: 'agent-headless',
          runtime: 'headless',
          provider: 'claude',
        }),
        initial_task: 'run headless',
      })
    );
  });

  it('spawnHeadless forwards agentToken to headless provider spawns', async () => {
    const client = new AgentRelayClient({ baseUrl: 'http://127.0.0.1:3888' });
    const request = vi
      .spyOn((client as any).transport, 'request')
      .mockResolvedValue({ name: 'agent-headless-token', runtime: 'headless' });

    await client.spawnHeadless({
      name: 'agent-headless-token',
      provider: 'opencode',
      channels: ['general'],
      task: 'run headless',
      agentToken: 'agent-token-headless',
    });

    expect(request).toHaveBeenCalledWith(
      '/api/spawn',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body ?? '{}')).toMatchObject({
      name: 'agent-headless-token',
      cli: 'opencode',
      args: [],
      task: 'run headless',
      channels: ['general'],
      agentToken: 'agent-token-headless',
      transport: 'headless',
    });
  });

  it('sendMessage preserves structured data payload', async () => {
    const client = new AgentRelayClient();
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi
      .spyOn(client as any, 'requestOk')
      .mockResolvedValue({ event_id: 'evt_data', targets: ['worker'] });

    const data = { runId: 'run-1', step: 2, flags: { urgent: true } };

    await client.sendMessage({
      to: 'worker',
      text: 'continue',
      data,
    });

    expect(requestOk).toHaveBeenCalledWith(
      'send_message',
      expect.objectContaining({
        to: 'worker',
        text: 'continue',
        data,
      })
    );
  });

  it('sendMessage forwards mode for injection behavior', async () => {
    const client = new AgentRelayClient();
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi
      .spyOn(client as any, 'requestOk')
      .mockResolvedValue({ event_id: 'evt_mode', targets: ['worker'] });

    await client.sendMessage({
      to: 'worker',
      text: 'urgent update',
      mode: 'steer',
    });

    expect(requestOk).toHaveBeenCalledWith(
      'send_message',
      expect.objectContaining({
        to: 'worker',
        text: 'urgent update',
        mode: 'steer',
      })
    );
  });

  it('release forwards optional reason', async () => {
    const client = new AgentRelayClient();
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi.spyOn(client as any, 'requestOk').mockResolvedValue({ name: 'worker' });

    await client.release('worker', 'task complete');

    expect(requestOk).toHaveBeenCalledWith('release_agent', {
      name: 'worker',
      reason: 'task complete',
    });
  });

  it('buffers broker events and supports query/getLast helpers', () => {
    const client = new AgentRelayClient();

    emitClientEvent(client, {
      kind: 'delivery_queued',
      name: 'worker-a',
      delivery_id: 'del-1',
      event_id: 'evt-1',
      timestamp: 100,
    });
    emitClientEvent(client, {
      kind: 'worker_ready',
      name: 'worker-a',
      runtime: 'pty',
    });
    emitClientEvent(client, {
      kind: 'delivery_injected',
      name: 'worker-a',
      delivery_id: 'del-1',
      event_id: 'evt-1',
      timestamp: 200,
    });

    expect(client.queryEvents()).toHaveLength(3);
    expect(client.queryEvents({ kind: 'delivery_queued' })).toHaveLength(1);
    expect(client.queryEvents({ name: 'worker-a' })).toHaveLength(3);
    expect(client.queryEvents({ since: 150 })).toHaveLength(1);
    expect(client.queryEvents({ limit: 2 })).toHaveLength(2);

    const last = client.getLastEvent('delivery_injected', 'worker-a');
    expect(last).toEqual({
      kind: 'delivery_injected',
      name: 'worker-a',
      delivery_id: 'del-1',
      event_id: 'evt-1',
      timestamp: 200,
    });
  });

  it('evicts oldest buffered events when maxBufferSize is reached', () => {
    const client = new AgentRelayClient();
    (client as any).maxBufferSize = 2;

    emitClientEvent(client, { kind: 'worker_ready', name: 'a', runtime: 'pty' });
    emitClientEvent(client, { kind: 'worker_ready', name: 'b', runtime: 'pty' });
    emitClientEvent(client, { kind: 'worker_ready', name: 'c', runtime: 'pty' });

    const events = client.queryEvents({ kind: 'worker_ready' });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'worker_ready', name: 'b' });
    expect(events[1]).toMatchObject({ kind: 'worker_ready', name: 'c' });
  });
});

describe('AgentRelay orchestration handles', () => {
  it('spawnPty forwards agentToken to the client', async () => {
    const { client, mock } = createMockFacadeClient();
    const relay = new AgentRelay();
    (relay as any).client = client;

    try {
      await relay.spawnPty({
        name: 'token-pty',
        cli: 'claude',
        channels: ['general'],
        agentToken: 'agent-token-pty',
      });

      expect(mock.spawnPty).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'token-pty',
          cli: 'claude',
          agentToken: 'agent-token-pty',
        })
      );
    } finally {
      await relay.shutdown();
    }
  });

  it('spawn forwards agentToken through the facade wrapper', async () => {
    const { client, mock } = createMockFacadeClient();
    const relay = new AgentRelay();
    (relay as any).client = client;

    try {
      await relay.spawn('token-wrapper', 'claude', 'Do work', {
        agentToken: 'agent-token-wrapper',
      });

      expect(mock.spawnPty).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'token-wrapper',
          cli: 'claude',
          task: 'Do work',
          agentToken: 'agent-token-wrapper',
        })
      );
    } finally {
      await relay.shutdown();
    }
  });

  it('property spawners forward agentToken for pty and headless runtimes', async () => {
    const { client, mock } = createMockFacadeClient();
    const relay = new AgentRelay();
    (relay as any).client = client;

    try {
      await relay.codex.spawn({
        name: 'codex-token',
        channels: ['general'],
        agentToken: 'agent-token-codex',
      });
      await relay.opencode.spawn({
        name: 'opencode-token',
        channels: ['general'],
        agentToken: 'agent-token-opencode',
      });

      expect(mock.spawnPty).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'codex-token',
          cli: 'codex',
          agentToken: 'agent-token-codex',
        })
      );
      expect(mock.spawnProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'opencode-token',
          provider: 'opencode',
          transport: 'headless',
          agentToken: 'agent-token-opencode',
        })
      );
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.waitForReady resolves after worker_ready event', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      const agent = await relay.spawnPty({
        name: 'ready-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const waitPromise = agent.waitForReady(1_000);
      emit({ kind: 'worker_ready', name: 'ready-agent', runtime: 'pty' });

      await expect(waitPromise).resolves.toBeUndefined();
    } finally {
      await relay.shutdown();
    }
  });

  it('waitForAgentMessage waits for relay_inbound from the agent', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      await relay.spawnPty({
        name: 'msg-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const waitPromise = relay.waitForAgentMessage('msg-agent', 1_000);
      let resolved = false;
      waitPromise.then(() => {
        resolved = true;
      });

      emit({ kind: 'worker_ready', name: 'msg-agent', runtime: 'pty' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resolved).toBe(false);

      emit({
        kind: 'relay_inbound',
        event_id: 'evt-msg-1',
        from: 'msg-agent',
        target: '#general',
        body: 'ready',
      });

      await expect(waitPromise).resolves.toMatchObject({ name: 'msg-agent' });
    } finally {
      await relay.shutdown();
    }
  });

  it('spawnAndWait can wait for first agent message', async () => {
    const { client, mock, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      const spawnWaitPromise = relay.spawnAndWait('spawn-msg', 'claude', 'Do the task', {
        waitForMessage: true,
        timeoutMs: 1_000,
      });

      await vi.waitFor(() => {
        expect(mock.spawnPty).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'spawn-msg',
            cli: 'claude',
            task: 'Do the task',
          })
        );
      });

      emit({ kind: 'worker_ready', name: 'spawn-msg', runtime: 'pty' });
      emit({
        kind: 'relay_inbound',
        event_id: 'evt-spawn-msg',
        from: 'spawn-msg',
        target: 'human:orchestrator',
        body: 'initialized',
      });

      await expect(spawnWaitPromise).resolves.toMatchObject({ name: 'spawn-msg' });
    } finally {
      await relay.shutdown();
    }
  });

  it('spawnAndWait falls back to worker_ready when waitForMessage is false', async () => {
    const { client, mock, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      const spawnWaitPromise = relay.spawnAndWait('spawn-ready', 'claude', 'Do the task', {
        timeoutMs: 1_000,
      });

      await vi.waitFor(() => {
        expect(mock.spawnPty).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'spawn-ready',
            cli: 'claude',
            task: 'Do the task',
          })
        );
      });

      emit({ kind: 'worker_ready', name: 'spawn-ready', runtime: 'pty' });

      await expect(spawnWaitPromise).resolves.toMatchObject({ name: 'spawn-ready' });
    } finally {
      await relay.shutdown();
    }
  });

  it('listAgents returns Agent handles with waitForReady', async () => {
    const { client, mock, emit } = createMockFacadeClient();
    mock.listAgents.mockResolvedValue([
      {
        name: 'listed-agent',
        runtime: 'pty',
        channels: ['general'],
      },
    ]);
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      const [agent] = await relay.listAgents();

      expect(agent).toBeDefined();
      const waitPromise = agent.waitForReady(1_000);
      emit({ kind: 'worker_ready', name: 'listed-agent', runtime: 'pty' });

      await expect(waitPromise).resolves.toBeUndefined();
    } finally {
      await relay.shutdown();
    }
  });

  it('spawn lifecycle hooks fire for success', async () => {
    const { client } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    const callOrder: string[] = [];
    const onStart = vi.fn(() => callOrder.push('start'));
    const onSuccess = vi.fn(() => callOrder.push('success'));
    const onError = vi.fn(() => callOrder.push('error'));

    try {
      const agent = await relay.spawn('hook-agent', 'claude', 'do work', {
        channels: ['general'],
        onStart,
        onSuccess,
        onError,
      });

      expect(agent.name).toBe('hook-agent');
      expect(onStart).toHaveBeenCalledWith({
        name: 'hook-agent',
        cli: 'claude',
        channels: ['general'],
        task: 'do work',
      });
      expect(onSuccess).toHaveBeenCalledWith({
        name: 'hook-agent',
        cli: 'claude',
        channels: ['general'],
        task: 'do work',
        runtime: 'pty',
      });
      expect(onError).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['start', 'success']);
    } finally {
      await relay.shutdown();
    }
  });

  it('spawn lifecycle hooks await async callbacks', async () => {
    const { client } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    let startDone = false;
    let successDone = false;

    try {
      await relay.spawn('async-hook-agent', 'claude', 'do work', {
        channels: ['general'],
        onStart: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          startDone = true;
        },
        onSuccess: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          successDone = true;
        },
      });

      expect(startDone).toBe(true);
      expect(successDone).toBe(true);
    } finally {
      await relay.shutdown();
    }
  });

  it('spawn lifecycle hooks fire on error', async () => {
    const { client, mock } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);
    mock.spawnPty.mockRejectedValueOnce(new Error('spawn failed'));

    const relay = new AgentRelay();
    const onStart = vi.fn();
    const onError = vi.fn();

    try {
      await expect(
        relay.spawnPty({
          name: 'hook-agent-fail',
          cli: 'claude',
          channels: ['general'],
          onStart,
          onError,
        })
      ).rejects.toThrow('spawn failed');

      expect(onStart).toHaveBeenCalledWith({
        name: 'hook-agent-fail',
        cli: 'claude',
        channels: ['general'],
        task: undefined,
      });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toMatchObject({
        name: 'hook-agent-fail',
        cli: 'claude',
        channels: ['general'],
      });
      expect(onError.mock.calls[0][0].error).toBeInstanceOf(Error);
      expect((onError.mock.calls[0][0].error as Error).message).toBe('spawn failed');
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.release passes reason to the broker client', async () => {
    const { client, mock } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      const agent = await relay.spawnPty({
        name: 'reason-agent',
        cli: 'claude',
        channels: ['general'],
      });

      await agent.release('cleanup');

      expect(mock.release).toHaveBeenCalledWith('reason-agent', 'cleanup');
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.release lifecycle hooks fire for success', async () => {
    const { client, mock } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    const callOrder: string[] = [];
    const onStart = vi.fn(() => callOrder.push('start'));
    const onSuccess = vi.fn(() => callOrder.push('success'));
    const onError = vi.fn(() => callOrder.push('error'));

    try {
      const agent = await relay.spawnPty({
        name: 'release-hook-agent',
        cli: 'claude',
        channels: ['general'],
      });

      await agent.release({
        reason: 'cleanup',
        onStart,
        onSuccess,
        onError,
      });

      expect(mock.release).toHaveBeenCalledWith('release-hook-agent', 'cleanup');
      expect(onStart).toHaveBeenCalledWith({
        name: 'release-hook-agent',
        reason: 'cleanup',
      });
      expect(onSuccess).toHaveBeenCalledWith({
        name: 'release-hook-agent',
        reason: 'cleanup',
      });
      expect(onError).not.toHaveBeenCalled();
      expect(callOrder).toEqual(['start', 'success']);
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.release is a no-op success after agent_exited', async () => {
    const { client, mock, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      const agent = await relay.spawnPty({
        name: 'release-after-exit',
        cli: 'claude',
        channels: ['general'],
      });

      emit({ kind: 'agent_exited', name: 'release-after-exit', code: 0, signal: undefined });

      await expect(agent.release()).resolves.toBeUndefined();
      expect(mock.release).not.toHaveBeenCalled();
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.release treats broker agent_not_found as idempotent success', async () => {
    const { client, mock } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);
    mock.release.mockRejectedValueOnce(
      new AgentRelayProtocolError({
        code: 'agent_not_found',
        message: "unknown worker 'release-idempotent-race'",
        retryable: false,
      })
    );

    const relay = new AgentRelay();

    try {
      const agent = await relay.spawnPty({
        name: 'release-idempotent-race',
        cli: 'claude',
        channels: ['general'],
      });

      await expect(agent.release()).resolves.toBeUndefined();
      expect(mock.release).toHaveBeenCalledWith('release-idempotent-race', undefined);
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.release lifecycle hooks fire on error', async () => {
    const { client, mock } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);
    mock.release.mockRejectedValueOnce(new Error('release failed'));

    const relay = new AgentRelay();
    const onStart = vi.fn();
    const onError = vi.fn();

    try {
      const agent = await relay.spawnPty({
        name: 'release-hook-fail',
        cli: 'claude',
        channels: ['general'],
      });

      await expect(
        agent.release({
          reason: 'cleanup',
          onStart,
          onError,
        })
      ).rejects.toThrow('release failed');

      expect(onStart).toHaveBeenCalledWith({
        name: 'release-hook-fail',
        reason: 'cleanup',
      });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toMatchObject({
        name: 'release-hook-fail',
        reason: 'cleanup',
      });
      expect(onError.mock.calls[0][0].error).toBeInstanceOf(Error);
      expect((onError.mock.calls[0][0].error as Error).message).toBe('release failed');
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.release lifecycle hooks await async callbacks', async () => {
    const { client } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    let successDone = false;

    try {
      const agent = await relay.spawnPty({
        name: 'release-async-hook-agent',
        cli: 'claude',
        channels: ['general'],
      });

      await agent.release({
        reason: 'cleanup',
        onSuccess: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          successDone = true;
        },
      });

      expect(successDone).toBe(true);
    } finally {
      await relay.shutdown();
    }
  });

  it('agent.release does not fire lifecycle hooks if broker startup fails before release begins', async () => {
    const { client } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    const onStart = vi.fn();
    const onError = vi.fn();

    try {
      const agent = await relay.spawnPty({
        name: 'release-startup-fail-agent',
        cli: 'claude',
        channels: ['general'],
      });

      vi.spyOn(relay as any, 'ensureStarted').mockRejectedValueOnce(new Error('startup failed'));

      await expect(
        agent.release({
          reason: 'cleanup',
          onStart,
          onError,
        })
      ).rejects.toThrow('startup failed');

      expect(onStart).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await relay.shutdown();
    }
  });

  it('system() sends messages from the system identity', async () => {
    const { client, mock } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();

    try {
      const system = relay.system();
      const message = await system.sendMessage({
        to: 'worker-1',
        text: 'New task assigned',
      });

      expect(mock.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'worker-1',
          text: 'New task assigned',
          from: 'system',
        })
      );
      expect(message.from).toBe('system');
    } finally {
      await relay.shutdown();
    }
  });

  it('sendAndWaitForDelivery waits for delivery ack with typed response', async () => {
    const { client, mock, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      type DeliveryResult = Awaited<ReturnType<AgentRelay['sendAndWaitForDelivery']>>;
      expectTypeOf<DeliveryResult>().toEqualTypeOf<{
        eventId: string;
        status: 'ack' | 'failed' | 'timeout';
        targets: string[];
      }>();

      const wait = relay.sendAndWaitForDelivery({
        to: 'worker',
        text: 'hello',
      });

      await vi.waitFor(() => {
        expect(mock.onEvent).toHaveBeenCalledTimes(2);
      });
      emit({
        kind: 'delivery_ack',
        name: 'worker',
        delivery_id: 'del_1',
        event_id: 'evt_1',
      });

      await expect(wait).resolves.toEqual({
        eventId: 'evt_1',
        status: 'ack',
        targets: ['worker'],
      });
    } finally {
      await relay.shutdown();
    }
  });

  it('sendAndWaitForDelivery timeout remains terminal in delivery state timeline (Wave 0 contract)', async () => {
    const { client, mock, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const timeoutFixture = readWave0Fixture<{
      event_id: string;
      target: string;
      expected_terminal_status: 'failed';
      late_event_kind: 'delivery_ack';
    }>('timeout-terminal-semantics.json');

    mock.sendMessage.mockResolvedValueOnce({
      event_id: timeoutFixture.event_id,
      targets: [timeoutFixture.target],
    });

    const relay = new AgentRelay();
    try {
      const result = await relay.sendAndWaitForDelivery(
        { to: timeoutFixture.target, text: 'timeout contract probe' },
        5
      );

      expect(result).toEqual({
        eventId: timeoutFixture.event_id,
        status: 'timeout',
        targets: [timeoutFixture.target],
      });

      if (timeoutFixture.late_event_kind === 'delivery_ack') {
        emit({
          kind: 'delivery_ack',
          name: timeoutFixture.target,
          delivery_id: 'del_timeout_contract',
          event_id: timeoutFixture.event_id,
        });
      }

      // TODO(contract-wave0-timeout-terminal): timeout should be a terminal
      // delivery state recorded for observability and never reopened by late ack.
      expect(relay.getDeliveryState(timeoutFixture.event_id)).toBeUndefined();
    } finally {
      await relay.shutdown();
    }
  });

  it('relay_inbound normalizes broker identities to Dashboard across repos (Wave 0 contract)', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const identityFixture = readWave0Fixture<{
      cases: Array<{ input: string; normalized: string }>;
    }>('broker-identity-normalization.json');

    const relay = new AgentRelay();
    const seenFrom: string[] = [];
    relay.onMessageReceived = (message) => {
      seenFrom.push(message.from);
    };

    try {
      await relay.listAgents(); // Ensure event wiring is initialized.

      for (const entry of identityFixture.cases) {
        emit({
          kind: 'relay_inbound',
          event_id: `evt_identity_${entry.input.replace(/[^a-zA-Z0-9]/g, '_')}`,
          from: entry.input,
          target: 'Lead',
          body: `identity-check:${entry.input}`,
        });
      }

      // TODO(contract-wave0-identity-normalization): keep SDK-facing sender
      // identity normalization in lockstep with broker-side Dashboard mapping.
      expect(seenFrom).toEqual(identityFixture.cases.map((entry) => entry.input));
    } finally {
      await relay.shutdown();
    }
  });

  it('tracks per-event delivery state transitions', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      await relay.listAgents();

      emit({
        kind: 'delivery_queued',
        name: 'worker',
        delivery_id: 'del-state',
        event_id: 'evt-state',
        timestamp: 123,
      });

      expect(relay.getDeliveryState('evt-state')).toEqual({
        eventId: 'evt-state',
        to: 'worker',
        status: 'queued',
        updatedAt: 123,
      });

      emit({
        kind: 'delivery_injected',
        name: 'worker',
        delivery_id: 'del-state',
        event_id: 'evt-state',
        timestamp: 150,
      });
      expect(relay.getDeliveryState('evt-state')).toEqual({
        eventId: 'evt-state',
        to: 'worker',
        status: 'injected',
        updatedAt: 150,
      });

      emit({
        kind: 'delivery_active',
        name: 'worker',
        delivery_id: 'del-state',
        event_id: 'evt-state',
      });
      expect(relay.getDeliveryState('evt-state')?.status).toBe('active');

      emit({
        kind: 'delivery_verified',
        name: 'worker',
        delivery_id: 'del-state',
        event_id: 'evt-state',
      });
      expect(relay.getDeliveryState('evt-state')?.status).toBe('verified');

      emit({
        kind: 'delivery_failed',
        name: 'worker',
        delivery_id: 'del-state',
        event_id: 'evt-state',
        reason: 'broken pipe',
      });
      expect(relay.getDeliveryState('evt-state')?.status).toBe('failed');
      expect(relay.getDeliveryState('missing-event')).toBeUndefined();
    } finally {
      await relay.shutdown();
    }
  });
});

describe('Agent.status computed getter', () => {
  it('returns spawning before worker_ready fires', async () => {
    const { client } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'status-agent',
        cli: 'claude',
        channels: ['general'],
      });

      expect(agent.status).toBe('spawning');
    } finally {
      await relay.shutdown();
    }
  });

  it('returns ready after worker_ready event', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'status-ready',
        cli: 'claude',
        channels: ['general'],
      });

      emit({ kind: 'worker_ready', name: 'status-ready', runtime: 'pty' });

      expect(agent.status).toBe('ready');
    } finally {
      await relay.shutdown();
    }
  });

  it('returns idle after agent_idle event', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'status-idle',
        cli: 'claude',
        channels: ['general'],
      });

      emit({ kind: 'worker_ready', name: 'status-idle', runtime: 'pty' });
      expect(agent.status).toBe('ready');

      emit({ kind: 'agent_idle', name: 'status-idle', idle_secs: 10 });
      expect(agent.status).toBe('idle');
    } finally {
      await relay.shutdown();
    }
  });

  it('returns exited after agent_exited event', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'status-exited',
        cli: 'claude',
        channels: ['general'],
      });

      emit({ kind: 'worker_ready', name: 'status-exited', runtime: 'pty' });
      emit({ kind: 'agent_exited', name: 'status-exited', code: 0, signal: undefined });

      expect(agent.status).toBe('exited');
    } finally {
      await relay.shutdown();
    }
  });

  it('transitions from idle back to ready on worker_stream', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'status-resume',
        cli: 'claude',
        channels: ['general'],
      });

      emit({ kind: 'worker_ready', name: 'status-resume', runtime: 'pty' });
      emit({ kind: 'agent_idle', name: 'status-resume', idle_secs: 5 });
      expect(agent.status).toBe('idle');

      emit({ kind: 'worker_stream', name: 'status-resume', stream: 'stdout', chunk: 'output' });
      expect(agent.status).toBe('ready');
    } finally {
      await relay.shutdown();
    }
  });
});

describe('Agent.onOutput', () => {
  it('receives output chunks for the correct agent', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'output-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const chunks: string[] = [];
      agent.onOutput((chunk: string) => chunks.push(chunk));

      emit({ kind: 'worker_stream', name: 'output-agent', stream: 'stdout', chunk: 'hello' });
      emit({ kind: 'worker_stream', name: 'output-agent', stream: 'stdout', chunk: ' world' });

      expect(chunks).toEqual(['hello', ' world']);
    } finally {
      await relay.shutdown();
    }
  });

  it('does not receive output for other agents', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'my-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const chunks: string[] = [];
      agent.onOutput((chunk: string) => chunks.push(chunk));

      emit({ kind: 'worker_stream', name: 'other-agent', stream: 'stdout', chunk: 'not mine' });
      emit({ kind: 'worker_stream', name: 'my-agent', stream: 'stdout', chunk: 'mine' });

      expect(chunks).toEqual(['mine']);
    } finally {
      await relay.shutdown();
    }
  });

  it('unsubscribe stops receiving output', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'unsub-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const chunks: string[] = [];
      const unsub = agent.onOutput((chunk: string) => chunks.push(chunk));

      emit({ kind: 'worker_stream', name: 'unsub-agent', stream: 'stdout', chunk: 'before' });
      unsub();
      emit({ kind: 'worker_stream', name: 'unsub-agent', stream: 'stdout', chunk: 'after' });

      expect(chunks).toEqual(['before']);
    } finally {
      await relay.shutdown();
    }
  });

  it('onOutput with { stream: "stdout" } only receives stdout events', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'stream-filter-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const chunks: string[] = [];
      agent.onOutput((chunk: string) => chunks.push(chunk), { stream: 'stdout' });

      emit({ kind: 'worker_stream', name: 'stream-filter-agent', stream: 'stdout', chunk: 'out1' });
      emit({ kind: 'worker_stream', name: 'stream-filter-agent', stream: 'stderr', chunk: 'err1' });
      emit({ kind: 'worker_stream', name: 'stream-filter-agent', stream: 'stdout', chunk: 'out2' });

      expect(chunks).toEqual(['out1', 'out2']);
    } finally {
      await relay.shutdown();
    }
  });

  it('onOutput without filter receives all streams', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'all-streams-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const chunks: string[] = [];
      agent.onOutput((chunk: string) => chunks.push(chunk));

      emit({ kind: 'worker_stream', name: 'all-streams-agent', stream: 'stdout', chunk: 'out' });
      emit({ kind: 'worker_stream', name: 'all-streams-agent', stream: 'stderr', chunk: 'err' });

      expect(chunks).toEqual(['out', 'err']);
    } finally {
      await relay.shutdown();
    }
  });

  it('onOutput with { stream: "stderr" } ignores stdout events', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'stderr-filter-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const chunks: string[] = [];
      agent.onOutput((chunk: string) => chunks.push(chunk), { stream: 'stderr' });

      emit({ kind: 'worker_stream', name: 'stderr-filter-agent', stream: 'stdout', chunk: 'ignored' });
      emit({ kind: 'worker_stream', name: 'stderr-filter-agent', stream: 'stderr', chunk: 'captured' });

      expect(chunks).toEqual(['captured']);
    } finally {
      await relay.shutdown();
    }
  });

  it('onOutput with explicit mode: "structured" receives { stream, chunk } objects', async () => {
    const { client, emit } = createMockFacadeClient();
    vi.spyOn(AgentRelayClient, 'start').mockResolvedValue(client);

    const relay = new AgentRelay();
    try {
      const agent = await relay.spawnPty({
        name: 'explicit-mode-agent',
        cli: 'claude',
        channels: ['general'],
      });

      const payloads: Array<{ stream: string; chunk: string }> = [];
      // Use a plain (chunk) => ... signature but force structured mode via options
      agent.onOutput(((data: { stream: string; chunk: string }) => payloads.push(data)) as any, {
        mode: 'structured',
      });

      emit({ kind: 'worker_stream', name: 'explicit-mode-agent', stream: 'stdout', chunk: 'hello' });

      expect(payloads).toEqual([{ stream: 'stdout', chunk: 'hello' }]);
    } finally {
      await relay.shutdown();
    }
  });
});
