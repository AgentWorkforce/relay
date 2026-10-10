import { describe, expect, it, vi } from 'vitest';
import { parseRemovalWaitTimeout, waitForAgentRemoval } from './agent-removal.js';

function harness() {
  let time = 0;
  return {
    name: 'worker',
    timeoutMs: 1000,
    pollIntervalMs: 500,
    now: () => time,
    sleep: vi.fn(async (ms: number) => {
      time += ms;
    }),
    getAgent: vi.fn(async (): Promise<unknown> => ({ name: 'worker', status: 'released' })),
    listAgents: vi.fn(async () => [{ name: 'worker' }]),
  };
}
describe('registration removal wait', () => {
  it('polls released tombstones until confirmed not-found', async () => {
    const h = harness();
    h.getAgent.mockResolvedValueOnce({ status: 'released' }).mockRejectedValueOnce({ statusCode: 404 });
    expect(await waitForAgentRemoval(h)).toMatchObject({ cleared: true, waitedMs: 500 });
    expect(h.listAgents).not.toHaveBeenCalled();
  });
  it('uses one deadline membership check to clear persistent tombstones', async () => {
    const h = harness();
    h.listAgents.mockResolvedValueOnce([]);
    expect(await waitForAgentRemoval(h)).toMatchObject({ cleared: true, waitedMs: 1000 });
    expect(h.listAgents).toHaveBeenCalledTimes(1);
  });
  it('never clears on released status alone', async () => {
    expect(await waitForAgentRemoval(harness())).toMatchObject({ cleared: false, observedPresent: true });
  });
  it('does not confuse transport/auth errors with presence or deletion', async () => {
    const h = harness();
    h.getAgent.mockRejectedValue(new Error('403'));
    h.listAgents.mockRejectedValue(new Error('offline'));
    expect(await waitForAgentRemoval(h)).toMatchObject({
      cleared: false,
      observedPresent: false,
      readError: 'offline',
    });
  });
  it('does not sleep past the deadline', async () => {
    const h = harness();
    h.timeoutMs = 750;
    await waitForAgentRemoval(h);
    expect(h.sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 250]);
  });
  it('bounds never-settling reads including the final list read', async () => {
    vi.useFakeTimers();
    try {
      const result = waitForAgentRemoval({
        name: 'worker',
        timeoutMs: 1000,
        getAgent: () => new Promise(() => {}),
        listAgents: () => new Promise(() => {}),
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(await result).toMatchObject({ cleared: false, observedPresent: false, waitedMs: 2000 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseRemovalWaitTimeout', () => {
  // Timers take whole milliseconds; a fractional deadline would expire before
  // the scheduled sleep, and a sub-millisecond one would wait not at all.
  it('floors to whole milliseconds and clamps to the timer limit', () => {
    expect(parseRemovalWaitTimeout('1500.9')).toBe(1500);
    expect(parseRemovalWaitTimeout(1e12)).toBe(2_147_483_647);
    for (const value of ['0.5', '0', '-1', 'abc', 'Infinity']) {
      expect(() => parseRemovalWaitTimeout(value)).toThrow('--wait-timeout');
    }
  });
});
