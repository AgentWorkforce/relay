import { describe, expectTypeOf, it } from 'vitest';

import { AgentRelay } from '../index.js';
import type {
  RelayActionEvent,
  RelayEvent,
  RelayMessageEvent,
  RelayMessageReactedEvent,
  RelayMessageReadEventPublic,
} from '../listeners.js';

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
