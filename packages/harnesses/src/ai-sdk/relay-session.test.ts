import type { AgentIdentity, MessageContext, RelayMessage } from '@agent-relay/sdk';
import { describe, expect, it, vi } from 'vitest';
import { RelayHarnessSession } from './relay-session.js';

function message(id: string, text = id): RelayMessage {
  return { id, messageId: id, text, from: { id: 'human', name: 'Human', type: 'human' } } as RelayMessage;
}

function context(id: string, mode: MessageContext['mode'] = 'immediate'): MessageContext {
  return { id, mode, reason: 'message' };
}

function fakeHost() {
  const listeners = new Set<(event: never) => void>();
  let active = false;
  return {
    host: {
      get hasActiveTurn() {
        return active;
      },
      onEvent: vi.fn(
        (listener: (event: never) => void) => (listeners.add(listener), () => listeners.delete(listener))
      ),
      startTurn: vi.fn(async () => {
        active = true;
        return { turnId: 'turn', done: new Promise<void>(() => undefined) };
      }),
      submitUserMessage: vi.fn(async () => undefined),
      destroy: vi.fn(async () => {
        active = false;
      }),
    },
    settle() {
      active = false;
      for (const listener of listeners) {
        listener({
          type: 'turn.settled',
          turnId: 'turn',
          observability: {
            source: 'ai-sdk',
            fidelity: 'exact',
            sequence: 1,
            timestamp: new Date().toISOString(),
            turnId: 'turn',
          },
        } as never);
      }
    },
  };
}

const identity: AgentIdentity = { id: 'agent', name: 'Agent', handle: 'agent' };

describe('RelayHarnessSession', () => {
  it('starts idle turns, injects active messages, and deduplicates by idempotency key', async () => {
    const fixture = fakeHost();
    const session = new RelayHarnessSession({ identity, host: fixture.host as never });
    expect(
      await session.receiveMessage(message('one'), { ...context('delivery-1'), idempotencyKey: 'same' })
    ).toMatchObject({ status: 'accepted' });
    expect(await session.receiveMessage(message('two'), context('delivery-2'))).toMatchObject({
      status: 'accepted',
    });
    expect(fixture.host.submitUserMessage).toHaveBeenCalledWith('two');
    const duplicate = await session.receiveMessage(message('different'), {
      ...context('delivery-3'),
      idempotencyKey: 'same',
    });
    expect(duplicate).toMatchObject({ deliveryId: 'delivery-1' });
    expect(fixture.host.startTurn).toHaveBeenCalledTimes(1);
  });

  it('queues FIFO idle modes, drains one per settled turn, and fails newest overflow', async () => {
    const fixture = fakeHost();
    const session = new RelayHarnessSession({ identity, host: fixture.host as never, maxQueueSize: 2 });
    await session.receiveMessage(message('active'), context('active'));
    await expect(
      session.receiveMessage(message('queued-1'), context('queued-1', 'on-idle'))
    ).resolves.toMatchObject({ status: 'deferred', reason: 'queued_until_idle' });
    await expect(
      session.receiveMessage(message('queued-2'), context('queued-2', 'next-message'))
    ).resolves.toMatchObject({ status: 'deferred' });
    expect(await session.receiveMessage(message('overflow'), context('overflow', 'on-idle'))).toMatchObject({
      status: 'failed',
      retryable: true,
    });
    fixture.settle();
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(fixture.host.startTurn).toHaveBeenLastCalledWith('queued-1', 'queued-1');
    fixture.settle();
    await new Promise((resolveWait) => setTimeout(resolveWait, 0));
    expect(fixture.host.startTurn).toHaveBeenLastCalledWith('queued-2', 'queued-2');
  });

  it('publishes capabilities and releases once', async () => {
    const fixture = fakeHost();
    const session = new RelayHarnessSession({ identity, host: fixture.host as never });
    const events: string[] = [];
    session.onEvent?.((event) => events.push(event.type));
    expect(events).toContain('observability.capabilities');
    await Promise.all([session.release?.('done'), session.release?.('again')]);
    expect(fixture.host.destroy).toHaveBeenCalledTimes(1);
  });
});
