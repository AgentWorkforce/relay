import { describe, it, expect, vi } from 'vitest';
import { HookEmitter } from './emitter.js';

describe('HookEmitter', () => {
  it('invokes registered handlers with arguments and collects results', async () => {
    const emitter = new HookEmitter();
    const calls: string[] = [];

    emitter.on('start', (value) => {
      calls.push(`first-${value}`);
      return 'r1';
    });
    emitter.on('start', (value) => {
      calls.push(`second-${value}`);
      return 'r2';
    });

    const result = await emitter.emit('start', 'value');

    expect(calls).toEqual(['first-value', 'second-value']);
    expect(result.results).toEqual(['r1', 'r2']);
    expect(result.stopped).toBe(false);
  });

  it('supports async handlers and stops propagation when requested', async () => {
    const emitter = new HookEmitter();
    const order: number[] = [];

    emitter.on('event', async () => {
      order.push(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { stop: true };
    });

    emitter.on('event', () => {
      order.push(2);
      return 'should not run';
    });

    const result = await emitter.emit('event');

    expect(order).toEqual([1]);
    expect(result.stopped).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it('loads handlers from configuration object', async () => {
    const handlerA = vi.fn(() => 'a');
    const handlerB = vi.fn(() => 'b');
    const emitter = new HookEmitter({
      ready: [handlerA, handlerB],
    });

    const result = await emitter.emit('ready');

    expect(handlerA).toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalled();
    expect(result.results).toEqual(['a', 'b']);
  });

  it('supports unsubscribing handlers', async () => {
    const emitter = new HookEmitter();
    const handler = vi.fn(() => 'once');

    const off = emitter.on('cleanup', handler);
    off();

    const result = await emitter.emit('cleanup');

    expect(handler).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
  });
});
