import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { waitForExit } from './broker-process.js';

/**
 * A child that never exits unless told to. `kill` is observed rather than
 * obeyed, which is the case that matters: a process wedged in an
 * uninterruptible wait does not die when SIGKILL is delivered.
 */
function stubChild(options: { dieOnKill?: boolean } = {}): ChildProcess & {
  killed: NodeJS.Signals[];
} {
  const emitter = new EventEmitter() as unknown as ChildProcess & { killed: NodeJS.Signals[] };
  Object.assign(emitter, {
    exitCode: null,
    signalCode: null,
    killed: [] as NodeJS.Signals[],
    kill(signal: NodeJS.Signals) {
      (emitter.killed as NodeJS.Signals[]).push(signal);
      if (options.dieOnKill) emitter.emit('exit', null, signal);
      return true;
    },
  });
  return emitter;
}

describe('waitForExit', () => {
  it('reports an exit it observed', async () => {
    const child = stubChild();

    const pending = waitForExit(child, 50);
    child.emit('exit', 0, null);

    await expect(pending).resolves.toBe(true);
  });

  it('reports a process that is already gone without signalling it again', async () => {
    const child = stubChild();
    Object.assign(child, { signalCode: 'SIGTERM' });

    await expect(waitForExit(child, 50)).resolves.toBe(true);
    expect(child.killed).toEqual([]);
  });

  it('escalates to SIGKILL and reports the exit once it lands', async () => {
    const child = stubChild({ dieOnKill: true });

    await expect(waitForExit(child, 5)).resolves.toBe(true);
    expect(child.killed).toEqual(['SIGKILL']);
  });

  it('does not claim an exit it never saw after SIGKILL', async () => {
    const child = stubChild();

    // Resolving as soon as the signal was sent reports an exit nobody
    // observed; the CLI uses that answer to decide a broker is gone and its
    // node claim may be released.
    await expect(waitForExit(child, 5, 20)).resolves.toBe(false);
    expect(child.killed).toEqual(['SIGKILL']);
  });

  it('stops listening once it has settled', async () => {
    const child = stubChild();
    const removeListener = vi.spyOn(child, 'removeListener');

    const pending = waitForExit(child, 50);
    child.emit('exit', 0, null);
    await pending;

    expect(removeListener).toHaveBeenCalledWith('exit', expect.any(Function));
    expect(child.listenerCount('exit')).toBe(0);
  });
});
