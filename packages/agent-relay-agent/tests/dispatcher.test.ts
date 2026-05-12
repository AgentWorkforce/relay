import assert from 'node:assert/strict';
import test from 'node:test';

import { createCronTickEvent, createStartupEvent } from '@agent-relay/events';

import { createDispatcher } from '../src/dispatcher.js';
import type { Context } from '../src/types.js';

function createContext(signal: AbortSignal): Context {
  return {
    workspace: 'support',
    agentId: 'support-agent',
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    signal,
    tagged: (value) => value,
    files: {
      read: async () => null,
      write: async () => {},
      delete: async () => {},
      list: async () => [],
    },
    messages: {
      post: async () => ({ id: 'msg-1' }),
      reply: async () => ({ id: 'msg-2' }),
      dm: async () => ({ id: 'msg-3' }),
    },
    schedule: {
      at: async () => ({ id: 'sched-1' }),
      every: async () => ({ id: 'sched-2' }),
      cancel: async () => {},
    },
    raw: {
      relayfile: {} as never,
      relaycron: {} as never,
      relaycast: {} as never,
    },
    once: async (_key, fn) => fn(),
  };
}

test('dispatcher fans multiple event types into a single ordered handler', async () => {
  const seen: string[] = [];
  const signals: AbortSignal[] = [];

  const dispatcher = createDispatcher({
    concurrency: 1,
    handlerTimeoutMs: 1_000,
    createContext(signal) {
      signals.push(signal);
      return createContext(signal);
    },
    async onEvent(_ctx, event) {
      switch (event.type) {
        case 'startup':
          assert.equal(event.reason, 'cold-start');
          seen.push(`startup:${event.reason}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return;
        case 'cron.tick':
          assert.equal(event.schedule, '*/5 * * * *');
          seen.push(`cron:${event.schedule}`);
          return;
        default:
          assert.fail(`unexpected event type: ${event.type}`);
      }
    },
  });

  await Promise.all([
    dispatcher.dispatch(
      createStartupEvent({
        workspace: 'support',
        reason: 'cold-start',
      })
    ),
    dispatcher.dispatch(
      createCronTickEvent({
        workspace: 'support',
        scheduleId: 'sched_123',
        schedule: '*/5 * * * *',
        scheduledFor: '2026-05-11T12:00:00.000Z',
      })
    ),
  ]);

  assert.deepEqual(seen, ['startup:cold-start', 'cron:*/5 * * * *']);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});

test('dispatcher rejects queued work after close and future dispatches immediately', async () => {
  let releaseCurrent: (() => void) | null = null;

  const dispatcher = createDispatcher({
    concurrency: 1,
    handlerTimeoutMs: 1_000,
    createContext: createContext,
    async onEvent() {
      await new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
    },
  });

  const first = dispatcher.dispatch(
    createStartupEvent({
      workspace: 'support',
      reason: 'cold-start',
    })
  );
  const second = dispatcher.dispatch(
    createCronTickEvent({
      workspace: 'support',
      scheduleId: 'sched_queued',
      schedule: '*/5 * * * *',
      scheduledFor: '2026-05-11T12:00:00.000Z',
    })
  );

  dispatcher.close();
  releaseCurrent?.();

  await first;
  await assert.rejects(second, /Dispatcher closed/);
  await assert.rejects(
    dispatcher.dispatch(
      createCronTickEvent({
        workspace: 'support',
        scheduleId: 'sched_closed',
        schedule: '*/10 * * * *',
        scheduledFor: '2026-05-11T12:05:00.000Z',
      })
    ),
    /Dispatcher closed/
  );
});

test('dispatcher abortActive interrupts in-flight handlers and drain observes completion', async () => {
  let activeSignal: AbortSignal | null = null;

  const dispatcher = createDispatcher({
    concurrency: 1,
    handlerTimeoutMs: 1_000,
    createContext: createContext,
    async onEvent(ctx) {
      activeSignal = ctx.signal;
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            reject(ctx.signal.reason);
          },
          { once: true }
        );
      });
    },
  });

  const delivery = dispatcher.dispatch(
    createStartupEvent({
      workspace: 'support',
      reason: 'manual',
    })
  );

  await new Promise((resolve) => setImmediate(resolve));
  dispatcher.abortActive(new Error('Agent stopping'));

  await assert.rejects(delivery, /Agent stopping/);
  assert.equal(activeSignal?.aborted, true);
  assert.equal(await dispatcher.drain(250), true);
});

test('dispatcher times out a hanging handler', async () => {
  const dispatcher = createDispatcher({
    concurrency: 1,
    handlerTimeoutMs: 20,
    createContext: createContext,
    async onEvent() {
      await new Promise(() => {});
    },
  });

  await assert.rejects(
    dispatcher.dispatch(
      createCronTickEvent({
        workspace: 'support',
        scheduleId: 'sched_timeout',
        schedule: 'oneshot:timeout',
        scheduledFor: '2026-05-11T12:00:00.000Z',
      })
    ),
    /Handler timed out/
  );
});

test('dispatcher scopes burn headers to likely LLM fetches inside the handler', async () => {
  const originalFetch = globalThis.fetch;
  const seen = new Map<string, Headers>();

  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    seen.set(request.url, request.headers);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    const dispatcher = createDispatcher({
      concurrency: 1,
      handlerTimeoutMs: 1_000,
      createContext(signal) {
        return createContext(signal);
      },
      async onEvent() {
        await globalThis.fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5' }),
        });
        await globalThis.fetch('https://example.com/not-llm');
      },
    });

    await dispatcher.dispatch(
      createStartupEvent({
        workspace: 'support',
        reason: 'cold-start',
      })
    );

    const llmHeaders = seen.get('https://api.openai.com/v1/responses');
    assert.equal(llmHeaders?.get('x-relayburn-source'), 'agent-relay');
    assert.equal(llmHeaders?.get('x-relayburn-tag-workspace'), 'support');
    assert.equal(llmHeaders?.get('x-relayburn-tag-agent-id'), 'support-agent');
    assert.equal(llmHeaders?.get('x-relayburn-tag-event-type'), 'startup');

    const otherHeaders = seen.get('https://example.com/not-llm');
    assert.equal(otherHeaders?.get('x-relayburn-source'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
