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
    for (const handler of handlers.get(type) ?? []) handler(event);
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
    events: { on: bus.on },
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

  it('addListener accepts a predicate as well as a name', () => {
    const { relay } = createRelay();
    const engineer = relay.agent({ id: 'a-eng', name: 'engineer' });
    const handler = vi.fn();
    relay.addListener(engineer.status.becomes('idle'), handler);

    relay.emitSessionEvent('a-eng', { type: 'status.idle' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
