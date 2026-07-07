import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reflexSyncAndPush, startReflexCapture } from './reflex-capture.js';

/** Fake child process that scripts one run's stdout/stderr/exit (or an error). */
function makeChild(script: { stdout?: string; stderr?: string; code?: number; errorCode?: string }) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (script.errorCode) {
      const err = new Error('spawn failed') as NodeJS.ErrnoException;
      err.code = script.errorCode;
      child.emit('error', err);
      return;
    }
    if (script.stdout) child.stdout.emit('data', script.stdout);
    if (script.stderr) child.stderr.emit('data', script.stderr);
    child.emit('close', script.code ?? 0);
  });
  return child;
}

function fakeSpawn(byArgs: (args: string[]) => Parameters<typeof makeChild>[0]) {
  const calls: string[][] = [];
  const spawnFn = ((_bin: string, args: string[]) => {
    calls.push(args);
    return makeChild(byArgs(args));
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnFn, calls };
}

describe('startReflexCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op when reflex is disabled', async () => {
    const push = vi.fn(async () => ({ sent: 0, accepted: 0 }));
    const capture = startReflexCapture({ isEnabled: () => false, push, log: () => undefined });

    await vi.advanceTimersByTimeAsync(1_000_000);
    await capture.stop();

    expect(push).not.toHaveBeenCalled();
  });

  it('pushes after the initial delay and again on each interval', async () => {
    const push = vi.fn(async () => ({ sent: 2, accepted: 2 }));
    const log = vi.fn();
    const capture = startReflexCapture({
      isEnabled: () => true,
      push,
      log,
      initialDelayMs: 100,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[reflex] synced 2 record(s) to relayhistory-cloud');

    await vi.advanceTimersByTimeAsync(1000);
    expect(push).toHaveBeenCalledTimes(2);

    await capture.stop();
  });

  it('stops pushing when Reflex is disabled mid-run', async () => {
    let enabled = true;
    const push = vi.fn(async () => ({ sent: 1, accepted: 1 }));
    const capture = startReflexCapture({
      isEnabled: () => enabled,
      push,
      log: () => undefined,
      initialDelayMs: 10,
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10); // kickoff push
    expect(push).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); // one interval push
    expect(push).toHaveBeenCalledTimes(2);

    enabled = false; // `agent-relay reflex off` while `up` keeps running
    await vi.advanceTimersByTimeAsync(500); // several intervals, all gated off
    expect(push).toHaveBeenCalledTimes(2);

    await capture.stop(); // final flush is also gated off
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('does not push before the initial delay even when the interval is shorter', async () => {
    const push = vi.fn(async () => ({ sent: 0, accepted: 0 }));
    const capture = startReflexCapture({
      isEnabled: () => true,
      push,
      log: () => undefined,
      initialDelayMs: 1000,
      intervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(900);
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); // reach the initial delay
    expect(push).toHaveBeenCalledTimes(1);

    await capture.stop();
  });

  it('stop() flushes a final batch when idle', async () => {
    const push = vi.fn(async () => ({ sent: 1, accepted: 1 }));
    const capture = startReflexCapture({
      isEnabled: () => true,
      push,
      log: () => undefined,
      initialDelayMs: 100_000,
      intervalMs: 100_000,
    });

    // Timers are far out, so nothing has fired yet.
    expect(push).not.toHaveBeenCalled();

    await capture.stop();
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('swallows push errors and keeps running', async () => {
    const push = vi
      .fn<[], Promise<{ sent: number; accepted: number }>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ sent: 0, accepted: 0 });
    const log = vi.fn();
    const capture = startReflexCapture({
      isEnabled: () => true,
      push,
      log,
      initialDelayMs: 10,
      intervalMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[reflex] cloud sync failed: boom'));

    await vi.advanceTimersByTimeAsync(100);
    expect(push).toHaveBeenCalledTimes(2);

    await capture.stop();
  });
});

describe('reflexSyncAndPush', () => {
  // Real timers here: the fake child emits via setImmediate.
  it('syncs then pushes and parses the report', async () => {
    const { spawnFn, calls } = fakeSpawn((args) =>
      args[0] === 'sync'
        ? { code: 0 }
        : { code: 0, stdout: JSON.stringify({ sent: 2, accepted: 2, batchId: 'b', cursor: {} }) }
    );

    const result = await reflexSyncAndPush({ binPath: '/bin/echo', spawnFn });

    expect(result).toEqual({ sent: 2, accepted: 2 });
    expect(calls).toEqual([['sync'], ['push', '--json']]);
  });

  it('returns null and skips push when the binary is unavailable', async () => {
    const { spawnFn, calls } = fakeSpawn(() => ({ errorCode: 'ENOENT' }));
    const result = await reflexSyncAndPush({ binPath: '/bin/echo', spawnFn });
    expect(result).toBeNull();
    expect(calls).toEqual([['sync']]); // push never attempted
  });

  it('returns null when not authenticated', async () => {
    const { spawnFn } = fakeSpawn((args) =>
      args[0] === 'sync' ? { code: 0 } : { code: 1, stderr: 'error: not authenticated' }
    );
    expect(await reflexSyncAndPush({ binPath: '/bin/echo', spawnFn })).toBeNull();
  });

  it('rejects on other push failures', async () => {
    const { spawnFn } = fakeSpawn((args) => (args[0] === 'sync' ? { code: 0 } : { code: 2, stderr: 'boom' }));
    await expect(reflexSyncAndPush({ binPath: '/bin/echo', spawnFn })).rejects.toThrow(/exit 2.*boom/);
  });
});
