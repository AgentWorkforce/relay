import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRelay, ActionRegistry } from '../index.js';
import { createEventFanIn } from '../messaging/event-fanin.js';
import type { RelayMessaging, RelayMessagingEvent, RelayMessagingEventsSurface } from '../messaging/index.js';

/**
 * Fake events surface mirroring RelaycastMessagingClient's emit semantics:
 * every event fans out to its own type key AND to 'any'.
 */
function createFakeEventsSurface() {
  const handlers = new Map<string, Set<(event: RelayMessagingEvent) => void>>();
  const on = vi.fn((type: string, handler: (event: RelayMessagingEvent) => void) => {
    const set = handlers.get(type) ?? new Set();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  });
  const emit = (event: RelayMessagingEvent) => {
    for (const key of new Set([event.type, 'any'])) {
      for (const handler of handlers.get(key) ?? []) handler(event);
    }
  };
  const surface = {
    connect: vi.fn(),
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on,
  } as unknown as RelayMessagingEventsSurface & {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  return { surface, emit };
}

function messageCreated(messageId: string, text = 'hi', channel = 'general'): RelayMessagingEvent {
  return {
    type: 'messageCreated',
    channel,
    message: { messageId, text } as never,
  } as RelayMessagingEvent;
}

describe('createEventFanIn', () => {
  it('forwards events from a source added before connect', () => {
    const fanIn = createEventFanIn(undefined);
    const { surface, emit } = createFakeEventsSurface();
    fanIn.addSource(surface);

    const received: RelayMessagingEvent[] = [];
    fanIn.on('any', (event) => {
      received.push(event);
    });

    fanIn.connect();
    expect(surface.connect).toHaveBeenCalledTimes(1);

    emit(messageCreated('m1'));
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('messageCreated');
  });

  it('connects sources added after connect() was requested', () => {
    const fanIn = createEventFanIn(undefined, { noSourceWarningMs: 0 });
    const received: RelayMessagingEvent[] = [];
    fanIn.on('messageCreated', (event) => {
      received.push(event);
    });
    fanIn.connect();

    const { surface, emit } = createFakeEventsSurface();
    fanIn.addSource(surface);
    expect(surface.connect).toHaveBeenCalledTimes(1);

    emit(messageCreated('m1'));
    expect(received).toHaveLength(1);
  });

  it('dedupes the same message arriving from two sources, keeps distinct ones', () => {
    const fanIn = createEventFanIn(undefined);
    const a = createFakeEventsSurface();
    const b = createFakeEventsSurface();
    fanIn.addSource(a.surface);
    fanIn.addSource(b.surface);
    fanIn.connect();

    const received: RelayMessagingEvent[] = [];
    fanIn.on('any', (event) => {
      received.push(event);
    });

    a.emit(messageCreated('m1'));
    b.emit(messageCreated('m1'));
    expect(received).toHaveLength(1);

    a.emit(messageCreated('m2'));
    expect(received).toHaveLength(2);
  });

  it('passes genuine repeats from the same source while collapsing cross-source copies', () => {
    const fanIn = createEventFanIn(undefined);
    const a = createFakeEventsSurface();
    const b = createFakeEventsSurface();
    fanIn.addSource(a.surface);
    fanIn.addSource(b.surface);
    fanIn.connect();

    const received: RelayMessagingEvent[] = [];
    fanIn.on('any', (event) => {
      received.push(event);
    });

    const updated = (): RelayMessagingEvent =>
      ({ type: 'messageUpdated', channel: 'general', message: { messageId: 'm1', text: 'edit' } }) as never;

    // First edit: A delivers, B's copy collapses.
    a.emit(updated());
    b.emit(updated());
    expect(received).toHaveLength(1);

    // Second edit within the window: A already delivered the previous
    // occurrence, so this is a new occurrence — it must NOT be dropped.
    a.emit(updated());
    expect(received).toHaveLength(2);
    // ...and B's copy of the second edit collapses again.
    b.emit(updated());
    expect(received).toHaveLength(2);
  });

  it('disconnect() stops forwarding; connect() resumes it', async () => {
    const fanIn = createEventFanIn(undefined);
    const { surface, emit } = createFakeEventsSurface();
    fanIn.addSource(surface);
    fanIn.connect();

    const received: RelayMessagingEvent[] = [];
    fanIn.on('any', (event) => {
      received.push(event);
    });

    emit(messageCreated('m1'));
    expect(received).toHaveLength(1);

    await fanIn.disconnect();
    expect(surface.disconnect).toHaveBeenCalledTimes(1);
    emit(messageCreated('m2'));
    expect(received).toHaveLength(1);

    fanIn.connect();
    emit(messageCreated('m3'));
    expect(received).toHaveLength(2);
  });

  it('never dedupes per-source transport events', () => {
    const fanIn = createEventFanIn(undefined);
    const a = createFakeEventsSurface();
    const b = createFakeEventsSurface();
    fanIn.addSource(a.surface);
    fanIn.addSource(b.surface);
    fanIn.connect();

    const received: RelayMessagingEvent[] = [];
    fanIn.on('any', (event) => {
      received.push(event);
    });

    a.emit({ type: 'error' } as RelayMessagingEvent);
    b.emit({ type: 'error' } as RelayMessagingEvent);
    expect(received).toHaveLength(2);
  });

  it('uses the workspace fallback only until the first agent source connects', () => {
    const fallback = createFakeEventsSurface();
    const fanIn = createEventFanIn(fallback.surface, { noSourceWarningMs: 0 });

    const received: RelayMessagingEvent[] = [];
    fanIn.on('any', (event) => {
      received.push(event);
    });

    fanIn.connect();
    expect(fallback.surface.connect).toHaveBeenCalledTimes(1);
    fallback.emit(messageCreated('m1'));
    expect(received).toHaveLength(1);

    const agent = createFakeEventsSurface();
    fanIn.addSource(agent.surface);
    expect(agent.surface.connect).toHaveBeenCalledTimes(1);
    expect(fallback.surface.disconnect).toHaveBeenCalledTimes(1);

    // Detached fallback no longer forwards.
    fallback.emit(messageCreated('m2'));
    expect(received).toHaveLength(1);
    agent.emit(messageCreated('m3'));
    expect(received).toHaveLength(2);
  });

  it('replays desired channel subscriptions onto late sources', () => {
    const fanIn = createEventFanIn(undefined, { noSourceWarningMs: 0 });
    fanIn.subscribe(['general', 'ops']);
    fanIn.connect();

    const { surface } = createFakeEventsSurface();
    fanIn.addSource(surface);
    expect(surface.subscribe).toHaveBeenCalledWith(['general', 'ops']);
  });

  describe('no-source warning', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports when connect() has no agent source within the window', () => {
      const onError = vi.fn();
      const fanIn = createEventFanIn(undefined, { onError, noSourceWarningMs: 1000 });
      fanIn.connect();

      vi.advanceTimersByTime(1001);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0][0])).toContain('no registered agent');
    });

    it('stays silent when an agent source arrives in time', () => {
      const onError = vi.fn();
      const fanIn = createEventFanIn(undefined, { onError, noSourceWarningMs: 1000 });
      fanIn.connect();
      fanIn.addSource(createFakeEventsSurface().surface);

      vi.advanceTimersByTime(1001);
      expect(onError).not.toHaveBeenCalled();
    });
  });
});

describe('AgentRelay listener fan-in', () => {
  function createFakeMessaging(events: ReturnType<typeof createFakeEventsSurface>['surface']) {
    return {
      messages: {},
      events,
      workspace: {},
      agents: {
        register: vi.fn(async (input: { name: string }) => ({
          id: `id-${input.name}`,
          name: input.name,
          token: `tok-${input.name}`,
        })),
      },
    } as unknown as RelayMessaging;
  }

  function createHarness() {
    const workspaceEvents = createFakeEventsSurface();
    const agentEvents = new Map<string, ReturnType<typeof createFakeEventsSurface>>();
    const messaging = createFakeMessaging(workspaceEvents.surface);
    const relay = new AgentRelay({
      messaging,
      actions: new ActionRegistry(),
      createAgentMessaging: (token) => {
        const bus = createFakeEventsSurface();
        agentEvents.set(token, bus);
        return createFakeMessaging(bus.surface);
      },
    });
    return { relay, workspaceEvents, agentEvents };
  }

  it('relay.addListener receives channel messages via an agent registered first', async () => {
    const { relay, agentEvents } = createHarness();
    await relay.workspace.register({ name: 'listener' });

    const handler = vi.fn();
    relay.addListener('message.created', handler);

    const bus = agentEvents.get('tok-listener')!;
    expect(bus.surface.connect).toHaveBeenCalled();
    bus.emit(messageCreated('m1', 'hello', 'general'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].envelope.channel).toEqual({ name: 'general' });
  });

  it('relay.addListener attached before register streams once the agent arrives', async () => {
    const { relay, agentEvents } = createHarness();
    const handler = vi.fn();
    relay.addListener('message.created', handler);

    await relay.workspace.register({ name: 'late' });
    const bus = agentEvents.get('tok-late')!;
    expect(bus.surface.connect).toHaveBeenCalled();

    bus.emit(messageCreated('m1'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a message fanned to two registered agents surfaces once', async () => {
    const { relay, agentEvents } = createHarness();
    await relay.workspace.register(['one', 'two']);

    const handler = vi.fn();
    relay.addListener('message.created', handler);

    agentEvents.get('tok-one')!.emit(messageCreated('m1'));
    agentEvents.get('tok-two')!.emit(messageCreated('m1'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
