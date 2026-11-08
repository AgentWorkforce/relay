import { describe, expectTypeOf, it } from 'vitest';

import {
  AgentRelay,
  type AgentRelayAgent,
  type RelayAgentClient,
  type RelayMessage,
  type RelayMessageReaction,
  type RelayWorkspace,
  type ZodLikeSchema,
} from '../index.js';
import type { ActionCompletedEvent, RelayMessageEvent, TypedActionHandle } from '../listeners.js';
import type { RelayMessagingEventsSurface } from '../messaging/index.js';

declare const relay: AgentRelay;

function schema<T>(): ZodLikeSchema<T> {
  return { safeParse: (input: unknown) => ({ success: true, data: input as T }) };
}

describe('registered and reconnected agent client types', () => {
  it('accepts custom streams with a string-inferred scope property', () => {
    const existing = {} as Omit<RelayMessagingEventsSurface, 'scope'>;
    const customStream = { ...existing, scope: 'agent' };
    expectTypeOf(customStream.scope).toEqualTypeOf<string>();
    expectTypeOf(customStream).toExtend<RelayMessagingEventsSurface>();
  });

  it('exposes the complete agent surface from single and array registration and reconnect', async () => {
    const registered = await relay.workspace.register({ name: 'worker' });
    const registeredMany = await relay.workspace.register([{ name: 'worker-a' }, { name: 'worker-b' }]);
    const reconnected = await relay.workspace.reconnect({ apiToken: 'type-test-token' });

    expectTypeOf(registered).toEqualTypeOf<RelayAgentClient>();
    expectTypeOf(registeredMany).toEqualTypeOf<RelayAgentClient[]>();
    expectTypeOf(reconnected).toEqualTypeOf<RelayAgentClient>();

    for (const client of [registered, ...registeredMany, reconnected]) {
      expectTypeOf(client).toExtend<Omit<AgentRelayAgent, 'workspace'>>();
      expectTypeOf(client.events).toEqualTypeOf<AgentRelayAgent['events']>();
      expectTypeOf(client.capabilities).toEqualTypeOf<AgentRelayAgent['capabilities']>();
      expectTypeOf(client.capabilities.invoke('score.submit', { lead: 'acme' })).toEqualTypeOf<
        ReturnType<AgentRelayAgent['capabilities']['invoke']>
      >();
      expectTypeOf(client.sendMessage({ to: '#general', text: 'hello' })).toEqualTypeOf<
        Promise<RelayMessage>
      >();
      expectTypeOf(client.reply({ messageId: 'message-id', text: 'reply' })).toEqualTypeOf<
        Promise<RelayMessage>
      >();
      expectTypeOf(client.react({ messageId: 'message-id', emoji: '👍' })).toEqualTypeOf<
        Promise<RelayMessageReaction>
      >();
    }
  });

  it('preserves exact event narrowing on registered and reconnected clients', async () => {
    const registered = await relay.workspace.register({ name: 'worker' });
    const reconnected = await relay.workspace.reconnect({ apiToken: 'type-test-token' });

    for (const client of [registered, reconnected]) {
      expectTypeOf(
        client.addListener('message.created', (event) => {
          expectTypeOf(event).toEqualTypeOf<RelayMessageEvent<'message.created'>>();
        })
      ).toEqualTypeOf<() => void>();
      expectTypeOf(
        client.once('dm.received', (event) => {
          expectTypeOf(event).toEqualTypeOf<RelayMessageEvent<'dm.received'>>();
        })
      ).toEqualTypeOf<() => void>();
    }
  });

  it('exposes workspace mutations only on the parent workspace client', async () => {
    expectTypeOf(relay.workspace).toEqualTypeOf<RelayWorkspace>();
    const registered = await relay.workspace.register({ name: 'worker' });
    const reconnected = await relay.workspace.reconnect({ apiToken: 'type-test-token' });
    expectTypeOf(relay.workspace.release).toEqualTypeOf<RelayWorkspace['release']>();

    for (const client of [registered, reconnected]) {
      expectTypeOf(client.workspace.info()).toEqualTypeOf<ReturnType<RelayWorkspace['info']>>();
      // @ts-expect-error Agent-scoped clients cannot register another agent.
      client.workspace.register({ name: 'another-worker' });
      // @ts-expect-error Reconnecting an agent requires the parent workspace client.
      client.workspace.reconnect({ apiToken: 'another-type-test-token' });
      // @ts-expect-error Releasing an agent requires the parent workspace client.
      client.workspace.release({ name: 'worker' });
    }
  });

  it('preserves action schema and completion predicate inference', async () => {
    const registered = await relay.workspace.register({ name: 'worker' });
    const reconnected = await relay.workspace.reconnect({ apiToken: 'type-test-token' });

    for (const client of [registered, reconnected]) {
      const action = client.registerAction({
        name: 'score.submit',
        input: schema<{ lead: string }>(),
        output: schema<{ score: number }>(),
        handler: ({ input }) => {
          expectTypeOf(input).toEqualTypeOf<{ lead: string }>();
          return { score: input.lead.length };
        },
      });

      expectTypeOf(action).toEqualTypeOf<TypedActionHandle<{ lead: string }, { score: number }>>();
      client.addListener(action.completed(), (event) => {
        expectTypeOf(event).toEqualTypeOf<ActionCompletedEvent<{ lead: string }, { score: number }>>();
        expectTypeOf(event.output.score).toEqualTypeOf<number>();
      });
    }
  });
});
