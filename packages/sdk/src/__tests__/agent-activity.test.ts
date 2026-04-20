import { describe, expect, it, vi } from 'vitest';

import type { BrokerEvent } from '../protocol.js';
import { AgentRelay, type AgentActivityChange } from '../relay.js';

function createMockFacadeClient() {
  const listeners = new Set<(event: BrokerEvent) => void>();

  const client = {
    onEvent: vi.fn((listener: (event: BrokerEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };

  const emit = (event: BrokerEvent) => {
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  };

  return { client, emit };
}

function wireRelay(relay: AgentRelay, client: ReturnType<typeof createMockFacadeClient>['client']): void {
  (relay as any).client = client;
  (relay as any).wireEvents(client);
}

describe('AgentRelay onAgentActivityChanged', () => {
  it('emits active on first delivery event', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);
    const changes: AgentActivityChange[] = [];
    relay.onAgentActivityChanged = (change) => changes.push(change);

    emit({ kind: 'delivery_queued', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', timestamp: 1 });

    expect(changes).toEqual([
      {
        name: 'worker-1',
        active: true,
        pendingDeliveries: 1,
        reason: 'delivery_queued',
        eventId: 'e1',
      },
    ]);
  });

  it('does not emit repeated active transitions while already active', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);
    const changes: AgentActivityChange[] = [];
    relay.onAgentActivityChanged = (change) => changes.push(change);

    emit({ kind: 'delivery_queued', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', timestamp: 1 });
    emit({ kind: 'delivery_injected', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', timestamp: 2 });
    emit({ kind: 'delivery_active', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', pattern: 'output' });
    emit({ kind: 'delivery_ack', name: 'worker-1', delivery_id: 'd1', event_id: 'e1' });

    expect(changes).toHaveLength(1);
    expect(changes[0]?.reason).toBe('delivery_queued');
  });

  it('emits inactive on relay_inbound', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);
    const changes: AgentActivityChange[] = [];
    relay.onAgentActivityChanged = (change) => changes.push(change);

    emit({ kind: 'delivery_queued', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', timestamp: 1 });
    emit({
      kind: 'relay_inbound',
      event_id: 'reply-1',
      from: 'worker-1',
      target: '#general',
      body: 'done',
    });

    expect(changes.at(-1)).toEqual({
      name: 'worker-1',
      active: false,
      pendingDeliveries: 0,
      reason: 'relay_inbound',
      eventId: 'reply-1',
    });
  });

  it('emits inactive on agent_idle', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);
    const changes: AgentActivityChange[] = [];
    relay.onAgentActivityChanged = (change) => changes.push(change);

    emit({ kind: 'delivery_ack', name: 'worker-1', delivery_id: 'd1', event_id: 'e1' });
    emit({ kind: 'agent_idle', name: 'worker-1', idle_secs: 30 });

    expect(changes.at(-1)).toEqual({
      name: 'worker-1',
      active: false,
      pendingDeliveries: 0,
      reason: 'agent_idle',
      eventId: undefined,
    });
  });

  it('concurrent deliveries do not flip inactive too early', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);
    const changes: AgentActivityChange[] = [];
    relay.onAgentActivityChanged = (change) => changes.push(change);

    emit({ kind: 'delivery_queued', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', timestamp: 1 });
    emit({ kind: 'delivery_queued', name: 'worker-1', delivery_id: 'd2', event_id: 'e2', timestamp: 2 });
    emit({ kind: 'delivery_failed', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', reason: 'timeout' });

    expect(changes).toHaveLength(1);

    emit({ kind: 'delivery_failed', name: 'worker-1', delivery_id: 'd2', event_id: 'e2', reason: 'timeout' });

    expect(changes.at(-1)).toEqual({
      name: 'worker-1',
      active: false,
      pendingDeliveries: 0,
      reason: 'delivery_failed',
      eventId: 'e2',
    });
  });

  it('emits inactive on exit and release', () => {
    const relay = new AgentRelay();
    const { client, emit } = createMockFacadeClient();
    wireRelay(relay, client);
    const changes: AgentActivityChange[] = [];
    relay.onAgentActivityChanged = (change) => changes.push(change);

    emit({ kind: 'delivery_queued', name: 'worker-1', delivery_id: 'd1', event_id: 'e1', timestamp: 1 });
    emit({ kind: 'agent_exited', name: 'worker-1', code: 0, signal: undefined });
    emit({ kind: 'delivery_queued', name: 'worker-2', delivery_id: 'd2', event_id: 'e2', timestamp: 2 });
    emit({ kind: 'agent_released', name: 'worker-2' });

    expect(changes).toContainEqual({
      name: 'worker-1',
      active: false,
      pendingDeliveries: 0,
      reason: 'agent_exited',
      eventId: undefined,
    });
    expect(changes).toContainEqual({
      name: 'worker-2',
      active: false,
      pendingDeliveries: 0,
      reason: 'agent_released',
      eventId: undefined,
    });
  });
});
