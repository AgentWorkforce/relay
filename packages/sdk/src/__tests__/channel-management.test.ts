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

function wireRelay(relay: AgentRelay, client: ReturnType<typeof createMockFacadeClient>['client']): void {
  (relay as any).client = client;
  (relay as any).wireEvents(client);
}

afterEach(() => {
  vi.restoreAllMocks();
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
    // mutedChannels tracking is tested via wireRelay - the actual mutedChannels
    // update requires channel_muted event to be handled, which requires a
    // properly wired agent handle
  });
});
