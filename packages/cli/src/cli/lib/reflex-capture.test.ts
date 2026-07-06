import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startReflexCapture } from './reflex-capture.js';

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
