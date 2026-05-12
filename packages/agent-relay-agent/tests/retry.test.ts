import assert from 'node:assert/strict';
import test from 'node:test';

import { createCronTickEvent, events, NoRetry } from '@agent-relay/events';

test('event delivery retries once on throw and increments the attempt count', async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalRandom = Math.random;
  const originalWebSocket = globalThis.WebSocket;
  const requestedDelays: number[] = [];

  globalThis.setTimeout = ((callback: TimerHandler, delay?: number) => {
    requestedDelays.push(Number(delay ?? 0));
    queueMicrotask(() => {
      if (typeof callback === 'function') {
        callback();
      }
    });
    return 0 as never;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof globalThis.clearTimeout;
  Math.random = () => 0;

  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Math.random = originalRandom;
    globalThis.WebSocket = originalWebSocket;
  });
  globalThis.WebSocket = undefined as typeof globalThis.WebSocket;

  const attempts: number[] = [];
  const stream = events({
    workspace: 'support',
    apiKey: 'relay_ws_test',
    signal: new AbortController().signal,
    onEvent: async (event) => {
      attempts.push(event.attempt);
      if (event.attempt === 1) {
        throw new Error('fail once');
      }
    },
  });

  await stream.trigger(
    createCronTickEvent({
      workspace: 'support',
      scheduleId: 'sched_retry',
      schedule: 'oneshot:retry',
      scheduledFor: '2026-05-11T12:00:00.000Z',
    })
  );

  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(requestedDelays, [1_000]);
  await stream.close();
});

test('NoRetry short-circuits the retry loop', async () => {
  let calls = 0;

  const stream = events({
    workspace: 'support',
    apiKey: 'relay_ws_test',
    signal: AbortSignal.abort(),
    onEvent: async () => {
      calls += 1;
      throw new NoRetry('stop here');
    },
  });

  await assert.rejects(
    stream.trigger(
      createCronTickEvent({
        workspace: 'support',
        scheduleId: 'sched_noretry',
        schedule: 'oneshot:no-retry',
        scheduledFor: '2026-05-11T12:00:00.000Z',
      })
    ),
    /stop here/
  );
  assert.equal(calls, 1);

  await stream.close();
});
