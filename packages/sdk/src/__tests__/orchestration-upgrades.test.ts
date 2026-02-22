import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { AgentRelayClient } from '../client.js';
import { AgentRelay } from '../relay.js';
import { PROTOCOL_VERSION, type BrokerEvent } from '../protocol.js';

function createMockFacadeClient() {
  const listeners = new Set<(event: BrokerEvent) => void>();

  const mock = {
    spawnPty: vi.fn(async (input: { name: string }) => ({ name: input.name, runtime: 'pty' as const })),
    listAgents: vi.fn(
      async () =>
        [] as Array<{
          name: string;
          runtime: 'pty' | 'headless_claude';
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
});
