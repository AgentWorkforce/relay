import { describe, expect, it, vi } from 'vitest';

import { EventBus, type EventMap } from '../event-bus.js';

interface Events extends EventMap {
  ping: [{ id: number }];
  warm: [string, number];
  silent: [];
}

describe('EventBus', () => {
  it('dispatches to multiple listeners in registration order', async () => {
    const bus = new EventBus<Events>();
    const calls: number[] = [];
    bus.addListener('ping', (p) => {
      calls.push(p.id * 10 + 1);
    });
    bus.addListener('ping', (p) => {
      calls.push(p.id * 10 + 2);
    });
    bus.addListener('ping', (p) => {
      calls.push(p.id * 10 + 3);
    });

    await bus.emit('ping', { id: 5 });

    expect(calls).toEqual([51, 52, 53]);
  });

  it('returns an unsubscribe function that removes the handler', async () => {
    const bus = new EventBus<Events>();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.addListener('ping', a);
    bus.addListener('ping', b);
    expect(bus.listenerCount('ping')).toBe(2);

    offA();

    expect(bus.listenerCount('ping')).toBe(1);
    await bus.emit('ping', { id: 1 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('removeListener is idempotent', () => {
    const bus = new EventBus<Events>();
    const a = vi.fn();
    bus.addListener('ping', a);
    bus.removeListener('ping', a);
    bus.removeListener('ping', a);
    expect(bus.listenerCount('ping')).toBe(0);
  });

  it('drops the event-name entry when the last listener is removed', () => {
    const bus = new EventBus<Events>();
    const a = vi.fn();
    const off = bus.addListener('ping', a);
    expect(bus.listenerCount('ping')).toBe(1);
    off();
    expect(bus.listenerCount('ping')).toBe(0);
    // Re-add should restart cleanly
    bus.addListener('ping', a);
    expect(bus.listenerCount('ping')).toBe(1);
  });

  it('awaits async listeners sequentially', async () => {
    const bus = new EventBus<Events>();
    const order: string[] = [];
    bus.addListener('ping', async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('a');
    });
    bus.addListener('ping', () => {
      order.push('b');
    });

    await bus.emit('ping', { id: 0 });

    expect(order).toEqual(['a', 'b']);
  });

  it('catches and logs handler errors without aborting the chain', async () => {
    const bus = new EventBus<Events>();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    bus.addListener('ping', () => {
      throw new Error('boom');
    });
    bus.addListener('ping', after);

    await bus.emit('ping', { id: 1 });

    expect(after).toHaveBeenCalledTimes(1);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it('listeners() snapshot is safe under concurrent mutation', async () => {
    const bus = new EventBus<Events>();
    const calls: string[] = [];
    // Forward-declared so the handler can self-remove via the unsubscribe.
    // eslint-disable-next-line prefer-const
    let off!: () => void;
    bus.addListener('ping', () => {
      calls.push('first');
      // Self-remove from inside a handler — must not affect the current emit pass.
      off();
    });
    off = bus.addListener('ping', () => {
      calls.push('second');
    });

    await bus.emit('ping', { id: 0 });
    expect(calls).toEqual(['first', 'second']);
    // After the emit, the second handler is gone
    await bus.emit('ping', { id: 1 });
    expect(calls).toEqual(['first', 'second', 'first']);
  });

  it('passes through positional args of arbitrary arity', async () => {
    const bus = new EventBus<Events>();
    const handler = vi.fn();
    bus.addListener('warm', handler);

    await bus.emit('warm', 'hello', 42);

    expect(handler).toHaveBeenCalledWith('hello', 42);
  });

  it('handles a zero-arg event', async () => {
    const bus = new EventBus<Events>();
    const handler = vi.fn();
    bus.addListener('silent', handler);

    await bus.emit('silent');

    expect(handler).toHaveBeenCalledWith();
  });

  it('does not blow up when emit is called with no listeners', async () => {
    const bus = new EventBus<Events>();
    await expect(bus.emit('ping', { id: 1 })).resolves.toBeUndefined();
  });
});
