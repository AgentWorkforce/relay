import { describe, expect, it, vi } from 'vitest';

import { AgentRelay, ActionRegistry } from '../index.js';
import type { RelayMessaging } from '../messaging/index.js';
import type { ZodLikeSchema } from '../actions/index.js';
import type { ActionCompletedEvent, ActionFailedEvent } from '../listeners.js';

/** Minimal zod-style validator carrying a static output type. */
function schema<T>(): ZodLikeSchema<T> {
  return { safeParse: (input: unknown) => ({ success: true, data: input as T }) };
}

interface ScoreInput {
  lead: string;
}

interface ScoreOutput {
  saved: boolean;
  score: number;
}

function createRelay() {
  const messaging = {
    messages: {},
    events: { on: vi.fn(() => () => {}), connect: vi.fn() },
    agents: {},
  } as unknown as RelayMessaging;
  const actions = new ActionRegistry();
  const relay = new AgentRelay({ messaging, actions });
  return { relay, actions };
}

function registerScore(relay: AgentRelay) {
  return relay.registerAction({
    name: 'score.submit',
    input: schema<ScoreInput>(),
    output: schema<ScoreOutput>(),
    handler: async ({ input }) => {
      if (input.lead === 'boom') throw new Error('scoring blew up');
      return { saved: true, score: input.lead.length };
    },
  });
}

describe('TypedActionHandle', () => {
  it('exposes the action name alongside unregister()', () => {
    const { relay } = createRelay();
    const handle = registerScore(relay);
    expect(handle.name).toBe('score.submit');
    expect(typeof handle.unregister).toBe('function');
  });

  it('handle.completed() delivers a typed event with the handler output', async () => {
    const { relay, actions } = createRelay();
    const handle = registerScore(relay);

    const seen: ActionCompletedEvent<ScoreInput, ScoreOutput>[] = [];
    relay.addListener(handle.completed(), (event) => {
      // Type-level: `output` is ScoreOutput and `input` is ScoreInput — no casts.
      const saved: boolean = event.output.saved;
      const lead: string | undefined = event.input?.lead;
      void saved;
      void lead;
      seen.push(event);
    });

    await actions.invoke({
      name: 'score.submit',
      input: { lead: 'acme' },
      caller: { name: 'scorer', type: 'agent' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: 'action.completed',
      action: 'score.submit',
      agent: { name: 'scorer', type: 'agent' },
      input: { lead: 'acme' },
      output: { saved: true, score: 4 },
    });
    expect(typeof seen[0].at).toBe('string');
  });

  it('handle.failed() delivers the error and does not fire completed()', async () => {
    const { relay, actions } = createRelay();
    const handle = registerScore(relay);

    const completed = vi.fn();
    const failed: ActionFailedEvent<ScoreInput>[] = [];
    relay.addListener(handle.completed(), completed);
    relay.addListener(handle.failed(), (event) => {
      const message: string = event.error;
      void message;
      failed.push(event);
    });

    await actions.invoke({
      name: 'score.submit',
      input: { lead: 'boom' },
      caller: { name: 'scorer', type: 'agent' },
    });

    expect(completed).not.toHaveBeenCalled();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      type: 'action.failed',
      action: 'score.submit',
      error: 'scoring blew up',
    });
  });

  it('handle predicates only match their own action', async () => {
    const { relay, actions } = createRelay();
    const handle = registerScore(relay);
    relay.registerAction({ name: 'other.action', handler: async () => ({ ok: true }) });

    const completed = vi.fn();
    relay.addListener(handle.completed(), completed);

    await actions.invoke({ name: 'other.action', input: {}, caller: { name: 'p', type: 'agent' } });
    expect(completed).not.toHaveBeenCalled();

    await actions.invoke({
      name: 'score.submit',
      input: { lead: 'x' },
      caller: { name: 'p', type: 'agent' },
    });
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('handle.completed().calledBy(agent) filters on the caller', async () => {
    const { relay, actions } = createRelay();
    const handle = registerScore(relay);

    const completed = vi.fn();
    relay.addListener(handle.completed().calledBy({ name: 'scorer' }), completed);

    await actions.invoke({
      name: 'score.submit',
      input: { lead: 'x' },
      caller: { name: 'someone-else', type: 'agent' },
    });
    expect(completed).not.toHaveBeenCalled();

    await actions.invoke({
      name: 'score.submit',
      input: { lead: 'x' },
      caller: { name: 'scorer', type: 'agent' },
    });
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('handle.invoked() fires before the handler completes', async () => {
    const { relay, actions } = createRelay();
    const handle = registerScore(relay);

    const order: string[] = [];
    relay.addListener(handle.invoked(), () => order.push('invoked'));
    relay.addListener(handle.completed(), () => order.push('completed'));

    await actions.invoke({
      name: 'score.submit',
      input: { lead: 'x' },
      caller: { name: 'p', type: 'agent' },
    });

    expect(order).toEqual(['invoked', 'completed']);
  });

  it('handle.denied() fires when availableTo rejects the caller', async () => {
    const { relay, actions } = createRelay();
    const handle = relay.registerAction({
      name: 'guarded',
      availableTo: [{ name: 'allowed' }],
      handler: async () => ({ ok: true }),
    });

    const denied = vi.fn();
    relay.addListener(handle.denied(), denied);

    await actions.invoke({ name: 'guarded', input: {}, caller: { name: 'intruder', type: 'agent' } });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(denied.mock.calls[0][0]).toMatchObject({
      type: 'action.denied',
      action: 'guarded',
      agent: { name: 'intruder', type: 'agent' },
    });
  });

  it('unregister() stops the action from being invokable', async () => {
    const { relay, actions } = createRelay();
    const handle = registerScore(relay);
    handle.unregister();

    const result = await actions.invoke({
      name: 'score.submit',
      input: { lead: 'x' },
      caller: { name: 'p', type: 'agent' },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('action_not_found');
  });

  it('the legacy string path (relay.action(name)) still works alongside the handle', async () => {
    const { relay, actions } = createRelay();
    const handle = registerScore(relay);

    const viaHandle = vi.fn();
    const viaString = vi.fn();
    relay.addListener(handle.completed(), viaHandle);
    relay.addListener(relay.action('score.submit').completed(), viaString);

    await actions.invoke({
      name: 'score.submit',
      input: { lead: 'x' },
      caller: { name: 'p', type: 'agent' },
    });

    expect(viaHandle).toHaveBeenCalledTimes(1);
    expect(viaString).toHaveBeenCalledTimes(1);
  });
});
