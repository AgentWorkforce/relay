import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentRelayClient } from '../client.js';
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

function wireRelay(relay: AgentRelay, client: ReturnType<typeof createMockFacadeClient>['client']): void {
  (relay as any).client = client;
  (relay as any).wireEvents(client);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('channel management protocol messages', () => {
  it('subscribeChannels sends the correct SdkToBroker message shape', async () => {
    const client = new AgentRelayClient();
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi.spyOn(client as any, 'requestOk').mockResolvedValue(undefined);

    await client.subscribeChannels('worker-1', ['ch-a', 'ch-b']);

    expect(requestOk).toHaveBeenCalledWith('subscribe_channels', {
      name: 'worker-1',
      channels: ['ch-a', 'ch-b'],
    });
  });

  it('unsubscribeChannels sends the correct SdkToBroker message shape', async () => {
    const client = new AgentRelayClient();
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi.spyOn(client as any, 'requestOk').mockResolvedValue(undefined);

    await client.unsubscribeChannels('worker-1', ['ch-b']);

    expect(requestOk).toHaveBeenCalledWith('unsubscribe_channels', {
      name: 'worker-1',
      channels: ['ch-b'],
    });
  });

  it('muteChannel sends the correct SdkToBroker message shape', async () => {
    const client = new AgentRelayClient();
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi.spyOn(client as any, 'requestOk').mockResolvedValue(undefined);

    await client.muteChannel('worker-1', 'ch-a');

    expect(requestOk).toHaveBeenCalledWith('mute_channel', {
      name: 'worker-1',
      channel: 'ch-a',
    });
  });

  it('unmuteChannel sends the correct SdkToBroker message shape', async () => {
    const client = new AgentRelayClient();
    vi.spyOn(client, 'start').mockResolvedValue(undefined);
    const requestOk = vi.spyOn(client as any, 'requestOk').mockResolvedValue(undefined);

    await client.unmuteChannel('worker-1', 'ch-a');

    expect(requestOk).toHaveBeenCalledWith('unmute_channel', {
      name: 'worker-1',
      channel: 'ch-a',
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

  it('channel_muted updates Agent.mutedChannels', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);

    const agent = (relay as any).ensureAgentHandle('worker-1', 'pty', ['ch-a']);

    emit({
      kind: 'channel_muted',
      name: 'worker-1',
      channel: 'ch-a',
    });

    expect(agent.channels).toEqual(['ch-a']);
    expect(agent.mutedChannels).toEqual(['ch-a']);
  });
});
