import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BrokerEvent } from '../protocol.js';
import { AgentRelay } from '../relay.js';

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

function setupRelay() {
  const relay = new AgentRelay();
  const mockClient = createMockFacadeClient();
  (relay as any).client = mockClient.client;
  (relay as any).wireEvents(mockClient.client);
  return { relay, ...mockClient };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentRelay channel operations', () => {
  it('relay.subscribe delegates to client', async () => {
    const { relay, client } = setupRelay();

    await relay.subscribe({ agent: 'worker-1', channels: ['ch-a', 'ch-b'] });

    expect(client.subscribeChannels).toHaveBeenCalledWith('worker-1', ['ch-a', 'ch-b']);
  });

  it('relay.mute delegates to client', async () => {
    const { relay, client } = setupRelay();

    await relay.mute({ agent: 'worker-1', channel: 'ch-a' });

    expect(client.muteChannel).toHaveBeenCalledWith('worker-1', 'ch-a');
  });

  it('Agent.subscribe updates the local channel list on success', async () => {
    const { relay, client } = setupRelay();
    const agent = (relay as any).ensureAgentHandle('worker-1', 'pty', ['ch-a']);

    await agent.subscribe(['ch-b']);

    expect(client.subscribeChannels).toHaveBeenCalledWith('worker-1', ['ch-b']);
    expect(agent.channels).toEqual(['ch-a', 'ch-b']);
  });

  it('Agent.mute adds the channel to mutedChannels', async () => {
    const { relay, client } = setupRelay();
    const agent = (relay as any).ensureAgentHandle('worker-1', 'pty', ['ch-a']);

    await agent.mute('ch-a');

    expect(client.muteChannel).toHaveBeenCalledWith('worker-1', 'ch-a');
    expect(agent.mutedChannels).toEqual(['ch-a']);
  });

  it('Agent.unmute removes the channel from mutedChannels', async () => {
    const { relay, client } = setupRelay();
    const agent = (relay as any).ensureAgentHandle('worker-1', 'pty', ['ch-a']);

    await agent.mute('ch-a');
    await agent.unmute('ch-a');

    expect(client.unmuteChannel).toHaveBeenCalledWith('worker-1', 'ch-a');
    expect(agent.mutedChannels).toEqual([]);
  });

  it('onChannelSubscribed fires on channel_subscribed events', () => {
    const { relay, emit } = setupRelay();
    const callback = vi.fn();
    relay.onChannelSubscribed = callback;

    emit({
      kind: 'channel_subscribed',
      name: 'worker-1',
      channels: ['ch-a'],
    });

    expect(callback).toHaveBeenCalledWith('worker-1', ['ch-a']);
  });

  it('onChannelMuted fires on channel_muted events', () => {
    const { relay, emit } = setupRelay();
    const callback = vi.fn();
    relay.onChannelMuted = callback;

    emit({
      kind: 'channel_muted',
      name: 'worker-1',
      channel: 'ch-a',
    });

    expect(callback).toHaveBeenCalledWith('worker-1', 'ch-a');
  });
});
