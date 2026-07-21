import { describe, expectTypeOf, it } from 'vitest';

import { AgentRelay } from '../index.js';
import type {
  RelayAgentActivityEvent,
  RelayActionEvent,
  RelayEvent,
  RelayMessageEvent,
  RelayMessageReactedEvent,
  RelayMessageReadEventPublic,
} from '../listeners.js';
import type { AgentSessionEvent } from '../session/index.js';

describe('addListener selector narrowing', () => {
  const relay = new AgentRelay({ workspaceKey: 'rk_type_test' });

  it('narrows exact message selectors to the message event type', () => {
    relay.addListener('message.created', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayMessageEvent<'message.created'>>();
      expectTypeOf(event.type).toEqualTypeOf<'message.created'>();
      expectTypeOf(event.message.text).toEqualTypeOf<string>();
    });

    relay.addListener('dm.received', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayMessageEvent<'dm.received'>>();
    });
  });

  it('narrows read, reacted, and action selectors', () => {
    relay.addListener('message.read', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayMessageReadEventPublic>();
      expectTypeOf(event.messageId).toEqualTypeOf<string>();
    });

    relay.addListener('message.reacted', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayMessageReactedEvent>();
      expectTypeOf(event.action).toEqualTypeOf<'added' | 'removed'>();
    });

    relay.addListener('action.completed', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayActionEvent<'action.completed'>>();
      expectTypeOf(event.type).toEqualTypeOf<'action.completed'>();
    });
  });

  it('narrows activity and canonical agent-event selectors', () => {
    relay.addListener('agent.activity.changed', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayAgentActivityEvent>();
      expectTypeOf(event.activity).toEqualTypeOf<
        'starting' | 'thinking' | 'typing' | 'using_tool' | 'waiting' | 'idle' | 'error'
      >();
    });

    relay.addListener('text.delta', (event) => {
      expectTypeOf(event.type).toEqualTypeOf<'text.delta'>();
      expectTypeOf(event.event).toEqualTypeOf<Extract<AgentSessionEvent, { type: 'text.delta' }>>();
      expectTypeOf(event.event.delta).toEqualTypeOf<string>();
    });
  });

  it('keeps the full union for wildcards and unknown selectors', () => {
    relay.addListener('*', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayEvent>();
    });

    relay.addListener('message.*', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayEvent>();
    });

    relay.addListener('custom.event', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayEvent>();
    });
  });

  it('narrows once() the same way as addListener', () => {
    relay.once('message.created', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayMessageEvent<'message.created'>>();
    });

    relay.once('*', (event) => {
      expectTypeOf(event).toEqualTypeOf<RelayEvent>();
    });
  });

  it('still accepts broad RelayEvent handlers for exact selectors', () => {
    const broad = (event: RelayEvent): void => {
      void event;
    };
    relay.addListener('message.created', broad);
    relay.once('message.read', broad);
  });
});
