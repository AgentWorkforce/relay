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
  const relay = new AgentRelay({ messaging, actions: new ActionRegistry() });
  return { relay, bus };
}

describe('Listener DSL (Phase B)', () => {
  it('relay.on with message.created().in().mentions() filters correctly', async () => {
    const { relay, bus } = createRelay();
    const handler = vi.fn();
    relay.on(relay.events.message.created().in('#ops').mentions({ handle: 'eng' }), handler);

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
    const { relay } = createRelay();
    const handler = vi.fn();
    relay.registerAction({ name: 'spawn-claude', handler: async () => ({ ok: true }) });
    relay.on(relay.action('spawn-claude').calledBy({ name: 'planner' }), handler);

    await relay.actions.invoke({ name: 'spawn-claude', input: {}, caller: { name: 'other', type: 'agent' } });
    expect(handler).not.toHaveBeenCalled();

    await relay.actions.invoke({
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
    relay.on(engineer.status.becomes('idle'), handler);

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
    relay.on(
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

  it('relay.notify can be used as the handler for relay.on', async () => {
    const { relay, bus } = createRelay();
    const notify = relay.notify({ name: 'taskManager' }, { type: 'mention' });
    relay.on(relay.events.message.created().in('#ops'), notify);

    bus.emit('messageCreated', { type: 'messageCreated', channel: 'ops', message: { text: 'hi' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(relay.messaging.messages.direct as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'taskManager' })
    );
  });
});
