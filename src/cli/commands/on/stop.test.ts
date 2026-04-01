import { afterEach, describe, expect, it, vi } from 'vitest';

const stopServicesMock = vi.hoisted(() => vi.fn());

vi.mock('./services.js', () => ({
  stopServices: stopServicesMock,
}));

import { goOffTheRelay } from './stop.js';

afterEach(() => {
  stopServicesMock.mockReset();
  vi.restoreAllMocks();
});

describe('goOffTheRelay', () => {
  it('stops services and logs via provided logger', async () => {
    const log = vi.fn();

    await goOffTheRelay({ log });

    expect(stopServicesMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Off the relay.');
  });

  it('falls back to console.log when no logger is provided', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await goOffTheRelay(undefined);

    expect(stopServicesMock).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith('Off the relay.');
  });
});
