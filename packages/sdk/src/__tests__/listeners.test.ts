import { describe, expect, it, vi } from 'vitest';

import { AgentRelay, ActionRegistry } from '../index.js';
import type { RelayMessaging } from '../messaging/index.js';

function createEventBus() {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  const on = (type: string, handler: (event: unknown) => void) => {
    const set = handlers.get(type) ?? new Set();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  };
  const emit = (type: string, event: unknown) => {
    // Mirror RelaycastMessagingClient's emit contract: every event fans out
    // to its own type key AND to 'any' (the events fan-in listens on 'any').
    for (const key of [type, 'any']) {
      for (const handler of handlers.get(key) ?? []) handler(event);
    }
  };
  return { on, emit };
}

function createRelay() {
  const bus = createEventBus();
  const messaging = {
    messages: {
      send: vi.fn(async (i: unknown) => ({ id: 'm', text: '', from: {}, ...((i as object) ?? {}) })),
      direct: vi.fn(async (i: unknown) => ({ id: 'd', text: '', from: {}, ...((i as object) ?? {}) })),
    },
    events: { on: bus.on, connect: vi.fn() },
    agents: { register: vi.fn() },
  } as unknown as RelayMessaging;
  const actions = new ActionRegistry();
  const relay = new AgentRelay({ messaging, actions });
  return { relay, bus, actions };
}

describe('Listener DSL (Phase B)', () => {
  it('relay.on with message.created().in().mentions() filters correctly', async () => {
    const { relay, bus } = createRelay();
    const handler = vi.fn();
    relay.addListener(relay.events.message.created().in('#ops').mentions({ handle: 'eng' }), handler);

    // wrong channel — ignored
    bus.emit('messageCreated', { type: 'messageCreated', channel: 'random', message: { text: '@eng hi' } });
    // right channel, no mention — ignored
    bus.emit('messageCreated', { type: 'messageCreated', channel: '#ops', message: { text: 'hi' } });
    // match
    bus.emit('messageCreated', {
      type: 'messageCreated',
      channel: 'ops',
      message: { text: 'hey @eng', mentions: ['eng'] },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('relay.on with action(name).calledBy(agent) fires on invocation by that caller', async () => {
    const { relay, actions } = createRelay();
    const handler = vi.fn();
    relay.registerAction({ name: 'spawn-claude', handler: async () => ({ ok: true }) });
    relay.addListener(relay.action('spawn-claude').calledBy({ name: 'planner' }), handler);

    await actions.invoke({ name: 'spawn-claude', input: {}, caller: { name: 'other', type: 'agent' } });
    expect(handler).not.toHaveBeenCalled();

    await actions.invoke({
      name: 'spawn-claude',
      input: {},
      caller: { name: 'planner', type: 'agent' },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('agent.status.becomes() fires on a matching session status event', () => {
    const { relay } = createRelay();
    const engineer = relay.agent({ id: 'a-eng', name: 'engineer' });
    const handler = vi.fn();
    relay.addListener(engineer.status.becomes('idle'), handler);

    relay.emitSessionEvent('a-other', { type: 'status.changed', status: 'idle' });
    expect(handler).not.toHaveBeenCalled();

    relay.emitSessionEvent('a-eng', { type: 'status.changed', status: 'active' });
    expect(handler).not.toHaveBeenCalled();

    relay.emitSessionEvent('a-eng', { type: 'status.changed', status: 'idle' });
    relay.emitSessionEvent('a-eng', { type: 'status.idle' });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('agent.tools.called().where() filters tool calls', () => {
    const { relay } = createRelay();
    const engineer = relay.agent({ id: 'a-eng', name: 'engineer' });
    const handler = vi.fn();
    relay.addListener(
      engineer.tools
        .called('bash')
        .where((call) => String((call.input as { command?: string })?.command).includes('npm test')),
      handler
    );

    relay.emitSessionEvent('a-eng', { type: 'tool.called', tool: 'bash', input: { command: 'ls' } });
    expect(handler).not.toHaveBeenCalled();

    relay.emitSessionEvent('a-eng', { type: 'tool.called', tool: 'bash', input: { command: 'npm test' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('addListener("message.created") delivers a discriminated event with a rich envelope', () => {
    const { relay, bus } = createRelay();
    const handler = vi.fn();
    relay.addListener('message.created', handler);

    bus.emit('any', {
      type: 'messageCreated',
      channel: 'general',
      message: {
        id: 'm1',
        messageId: 'm1',
        text: 'hi',
        from: { id: 'a1', name: 'alice' },
        channel: { name: 'general' },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0];
    expect(evt.type).toBe('message.created');
    expect(evt.message.messageId).toBe('m1');
    expect(evt.envelope.from).toEqual({ id: 'a1', name: 'alice' });
    expect(evt.envelope.channel).toEqual({ name: 'general' });
  });

  it('addListener maps reactions to message.reacted with an action', () => {
    const { relay, bus } = createRelay();
    const handler = vi.fn();
    relay.addListener('message.reacted', handler);

    bus.emit('any', { type: 'reactionAdded', messageId: 'm9', emoji: 'eyes', agentName: 'bob' });
    bus.emit('any', { type: 'reactionRemoved', messageId: 'm9', emoji: 'eyes', agentName: 'bob' });

    expect(handler.mock.calls.map((c) => c[0].action)).toEqual(['added', 'removed']);
  });

  it('addListener supports "*" and prefix wildcards', () => {
    const { relay, bus } = createRelay();
    const all = vi.fn();
    const messages = vi.fn();
    relay.addListener('*', all);
    relay.addListener('message.*', messages);

    bus.emit('any', { type: 'messageRead', messageId: 'm1', agentName: 'bob' });
    bus.emit('any', { type: 'agentOnline', agent: { name: 'x' } }); // not surfaced

    expect(all).toHaveBeenCalledTimes(1);
    expect(all.mock.calls[0][0].type).toBe('message.read');
    expect(messages).toHaveBeenCalledTimes(1);
  });

  it('addListener("action.completed") fires after a successful invocation', async () => {
    const { relay, actions } = createRelay();
    const handler = vi.fn();
    relay.registerAction({ name: 'greet', handler: async () => ({ ok: true }) });
    relay.addListener('action.completed', handler);

    await actions.invoke({ name: 'greet', input: {}, caller: { name: 'p', type: 'agent' } });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: 'action.completed', action: 'greet' });
  });

  it('addListener opens the event stream', () => {
    const { relay } = createRelay();
    relay.addListener('message.created', vi.fn());
    expect(relay.messaging.events.connect as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it('addListener accepts a predicate as well as a name', () => {
    const { relay } = createRelay();
    const engineer = relay.agent({ id: 'a-eng', name: 'engineer' });
    const handler = vi.fn();
    relay.addListener(engineer.status.becomes('idle'), handler);

    relay.emitSessionEvent('a-eng', { type: 'status.idle' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('onError hook', () => {
  async function flush() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('invokes the constructor onError hook with the listener selector', async () => {
    const bus = createEventBus();
    const messaging = {
      events: { on: bus.on, connect: vi.fn() },
    } as unknown as RelayMessaging;
    const onError = vi.fn();
    const relay = new AgentRelay({ messaging, actions: new ActionRegistry(), onError });
    const failure = new Error('handler exploded');
    relay.addListener('message.read', () => {
      throw failure;
    });

    bus.emit('any', { type: 'messageRead', messageId: 'm1', agentName: 'bob' });
    await flush();

    expect(onError).toHaveBeenCalledWith(failure, { source: 'listener', selector: 'message.read' });
  });

  it('catches async handler rejections and isolates throwing hooks', async () => {
    const { relay, bus } = createRelay();
    const onError = vi.fn(() => {
      throw new Error('hook exploded');
    });
    relay.onError(onError);
    const failure = new Error('async failure');
    relay.addListener('message.read', async () => {
      throw failure;
    });

    bus.emit('any', { type: 'messageRead', messageId: 'm1', agentName: 'bob' });
    await flush();

    expect(onError).toHaveBeenCalledWith(failure, { source: 'listener', selector: 'message.read' });
  });

  it('relay.onError returns an unsubscribe that restores the default warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { relay, bus } = createRelay();
      const onError = vi.fn();
      const off = relay.onError(onError);
      off();
      relay.addListener('message.read', () => {
        throw new Error('boom');
      });

      bus.emit('any', { type: 'messageRead', messageId: 'm1', agentName: 'bob' });
      await flush();

      expect(onError).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('message.read');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns instead of staying silent when a predicate handler throws and no hook is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { relay, bus } = createRelay();
      relay.addListener(relay.events.message.created(), () => {
        throw new Error('boom');
      });

      bus.emit('messageCreated', { type: 'messageCreated', channel: 'ops', message: { text: 'hi' } });
      await flush();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('message.created');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('once', () => {
  it('fires at most once for a string selector and then unsubscribes', () => {
    const { relay, bus } = createRelay();
    const handler = vi.fn();
    relay.once('message.read', handler);

    bus.emit('any', { type: 'messageRead', messageId: 'm1', agentName: 'bob' });
    bus.emit('any', { type: 'messageRead', messageId: 'm2', agentName: 'bob' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ type: 'message.read', messageId: 'm1' });
  });

  it('fires at most once for a predicate', () => {
    const { relay } = createRelay();
    const engineer = relay.agent({ id: 'a-eng', name: 'engineer' });
    const handler = vi.fn();
    relay.once(engineer.status.becomes('idle'), handler);

    relay.emitSessionEvent('a-eng', { type: 'status.idle' });
    relay.emitSessionEvent('a-eng', { type: 'status.idle' });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('can be unsubscribed before the first event', () => {
    const { relay, bus } = createRelay();
    const handler = vi.fn();
    const off = relay.once('message.read', handler);
    off();

    bus.emit('any', { type: 'messageRead', messageId: 'm1', agentName: 'bob' });

    expect(handler).not.toHaveBeenCalled();
  });
});
