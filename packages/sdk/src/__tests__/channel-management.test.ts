import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRelayClient } from '../client.js';
import type { BrokerEvent } from '../protocol.js';
import { AgentRelay } from '../relay.js';

const TEST_BASE_URL = 'http://127.0.0.1:3888';

function createMockFacadeClient() {
  const listeners = new Set<(event: BrokerEvent) => void>();

  const mock = {
    subscribeChannels: vi.fn(async () => undefined),
    unsubscribeChannels: vi.fn(async () => undefined),
    muteChannel: vi.fn(async () => undefined),
    unmuteChannel: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: BrokerEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };

  const emit = (event: BrokerEvent) => {
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  };

  return {
    client: mock,
    emit,
  };
}

function wireRelay(relay: AgentRelay, client: ReturnType<typeof createMockFacadeClient>['client']): void {
  (relay as any).client = client;
  (relay as any).wireEvents(client);
}

function createProtocolClient(): AgentRelayClient {
  return new AgentRelayClient({ baseUrl: TEST_BASE_URL });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('channel management protocol messages', () => {
  it('subscribeChannels posts the channel payload to the subscribe endpoint', async () => {
    const client = createProtocolClient();
    const request = vi.spyOn((client as any).transport, 'request').mockResolvedValue(undefined);

    await client.subscribeChannels('worker-1', ['ch-a', 'ch-b']);

    expect(request).toHaveBeenCalledWith(
      '/api/spawned/worker-1/subscribe',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body ?? '{}')).toEqual({
      channels: ['ch-a', 'ch-b'],
    });
  });

  it('unsubscribeChannels posts the channel payload to the unsubscribe endpoint', async () => {
    const client = createProtocolClient();
    const request = vi.spyOn((client as any).transport, 'request').mockResolvedValue(undefined);

    await client.unsubscribeChannels('worker-1', ['ch-b']);

    expect(request).toHaveBeenCalledWith(
      '/api/spawned/worker-1/unsubscribe',
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(request.mock.calls[0]?.[1]?.body ?? '{}')).toEqual({
      channels: ['ch-b'],
    });
  });
});

describe('channel management facade state updates', () => {
  it('channel_subscribed updates Agent.channels', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);

    const agent = (relay as any).ensureAgentHandle('worker-1', 'pty', ['ch-a']);

    emit({
      kind: 'channel_subscribed',
      name: 'worker-1',
      channels: ['ch-b'],
    });

    expect(agent.channels).toEqual(['ch-a', 'ch-b']);
  });
});
