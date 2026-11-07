import { describe, expect, it, vi } from 'vitest';

import {
  ActionRegistry,
  ActionRegistrationError,
  ActionValidationError,
  validateJsonSchemaLite,
  type JsonSchemaLite,
} from '../actions/index.js';
import {
  DeliveryRunner,
  RelayCapabilityError,
  type AgentDeliveryAdapter,
  type InjectionResult,
} from '../delivery/index.js';
import { RelaycastMessagingClient, type InboxItem, type RelayMessaging } from '../messaging/index.js';
import {
  MINIMAL_AGENT_SESSION_CAPABILITIES,
  defineHarness,
  normalizeAgentIdentity,
  type AgentSession,
  type ZodLikeSchema,
} from '../index.js';

describe('session contract helpers', () => {
  const reviewBot = () =>
    defineHarness<{ name: string }>({
      name: 'review-bot',
      create: async (input, context) => {
        const identity = normalizeAgentIdentity({
          id: context.agent.id,
          name: input.name,
          handle: context.agent.handle,
        });
        return {
          identity,
          capabilities: MINIMAL_AGENT_SESSION_CAPABILITIES,
          receiveMessage: async () => ({ status: 'delivered', deliveryId: 'del_session' }),
          release: async () => {},
        };
      },
    });

  it('produces registerable agents from a harness factory — no driver needed', async () => {
    const harness = reviewBot();

    const agent = harness.new({ name: 'reviewer' });
    expect(agent.name).toBe('reviewer');
    expect(agent.kind).toBe('session');
    expect(agent.config).toBe(harness.config);
    expect(agent.input).toEqual({ name: 'reviewer' });
    // The handle carries listener predicate builders like the managed harnesses.
    expect(typeof agent.status.becomes).toBe('function');
    expect(typeof agent.tools.called).toBe('function');

    const created = await harness.create({ name: 'second' });
    expect(created.name).toBe('second');
    expect(created.kind).toBe('session');
  });

  it('keeps the adapter on config so a runtime can bring the live session online', async () => {
    const session = await reviewBot().config.create(
      { name: 'reviewer' },
      { agent: { id: 'agent_reviewer', name: 'reviewer', handle: '@reviewer' } }
    );

    expect(session.identity).toEqual({ id: 'agent_reviewer', name: 'reviewer', handle: '@reviewer' });
    expect(session.capabilities.delivery.modes).toEqual(['immediate']);
    await expect(
      session.receiveMessage(makeInboxItem('in_session', 'hello').message, {
        id: 'del_session',
        mode: 'immediate',
        reason: 'message',
      })
    ).resolves.toEqual({ status: 'delivered', deliveryId: 'del_session' });
  });
});

describe('JSON-schema-lite validation', () => {
  it('validates the schema subset used by SDK action contracts', () => {
    const schema: JsonSchemaLite = {
      type: 'object',
      required: ['name', 'count'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 1 },
        tags: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
    };

    expect(validateJsonSchemaLite({ name: 'relay', count: 2, tags: ['sdk'] }, schema)).toEqual({
      valid: true,
      issues: [],
    });

    const invalid = validateJsonSchemaLite({ name: '', count: 0, tags: [1], extra: true }, schema);

    expect(invalid.valid).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '$.name', message: 'expected length >= 1' }),
        expect.objectContaining({ path: '$.count', message: 'expected value >= 1' }),
        expect.objectContaining({ path: '$.tags[0]', message: 'expected string' }),
        expect.objectContaining({ path: '$.extra', message: 'additional property is not allowed' }),
      ])
    );
  });

  it('supports enum and oneOf constraints', () => {
    const schema: JsonSchemaLite = {
      oneOf: [
        { type: 'object', required: ['kind'], properties: { kind: { const: 'ok' } } },
        { type: 'object', required: ['kind'], properties: { kind: { enum: ['error'] } } },
      ],
    };

    expect(validateJsonSchemaLite({ kind: 'ok' }, schema).valid).toBe(true);
    expect(validateJsonSchemaLite({ kind: 'other' }, schema).issues).toEqual([
      expect.objectContaining({
        path: '$',
        message: 'expected value to match exactly one oneOf schema, matched 0',
      }),
    ]);
  });
});

describe('ActionRegistry', () => {
  it('registers actions and validates input and output around handlers', async () => {
    const registry = new ActionRegistry();

    registry.register<{ text: string }, { echoed: string }>({
      name: 'echo',
      description: 'Echo text',
      inputSchema: {
        type: 'object',
        required: ['text'],
        additionalProperties: false,
        properties: {
          text: { type: 'string', minLength: 1 },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['echoed'],
        additionalProperties: false,
        properties: {
          echoed: { type: 'string' },
        },
      },
      handler: (input) => ({ echoed: input.text }),
    });

    await expect(registry.execute(' echo ', { text: 'hello' })).resolves.toEqual({
      echoed: 'hello',
    });
    expect(registry.get('echo')).toEqual(
      expect.objectContaining({
        name: 'echo',
        description: 'Echo text',
      })
    );
    await expect(registry.list()).resolves.toHaveLength(1);
  });

  it('rejects duplicate action names', () => {
    const registry = new ActionRegistry();
    registry.register({ name: 'echo', handler: (input) => input });

    expect(() => registry.register({ name: ' echo ', handler: (input) => input })).toThrow(
      ActionRegistrationError
    );
  });

  it('rejects invalid input before invoking the handler', async () => {
    const handler = vi.fn((input) => input);
    const registry = new ActionRegistry();
    registry.register({
      name: 'needs-name',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
      },
      handler,
    });

    await expect(registry.execute('needs-name', {})).rejects.toMatchObject({
      name: 'ActionValidationError',
      action: 'needs-name',
      phase: 'input',
    } satisfies Partial<ActionValidationError>);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects invalid handler output', async () => {
    const registry = new ActionRegistry();
    registry.register({
      name: 'bad-output',
      outputSchema: {
        type: 'object',
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
        },
      },
      handler: () => ({ ok: 'yes' }),
    });

    await expect(registry.execute('bad-output', undefined)).rejects.toMatchObject({
      name: 'ActionValidationError',
      action: 'bad-output',
      phase: 'output',
    } satisfies Partial<ActionValidationError>);
  });

  it('accepts Zod-like schemas and passes parsed values to handlers', async () => {
    const registry = new ActionRegistry();
    const inputSchema: ZodLikeSchema<{ count: number }> = {
      safeParse: (input) => {
        if (
          input &&
          typeof input === 'object' &&
          'count' in input &&
          typeof (input as { count?: unknown }).count === 'string'
        ) {
          return { success: true, data: { count: Number((input as { count: string }).count) } };
        }
        return {
          success: false,
          error: { issues: [{ path: ['count'], message: 'expected string count' }] },
        };
      },
    };

    registry.register({
      name: 'coerce-count',
      inputSchema,
      handler: (input) => ({ doubled: input.count * 2 }),
    });

    await expect(
      registry.invoke({
        name: 'coerce-count',
        input: { count: '21' },
        caller: { name: 'planner', type: 'agent' },
      })
    ).resolves.toEqual({ action: 'coerce-count', ok: true, output: { doubled: 42 } });

    await expect(
      registry.invoke({
        name: 'coerce-count',
        input: { count: 21 },
        caller: { name: 'planner', type: 'agent' },
      })
    ).resolves.toMatchObject({
      action: 'coerce-count',
      ok: false,
      error: { code: 'invalid_input', message: '$.count: expected string count' },
    });
  });
});

describe('DeliveryRunner', () => {
  it('refuses to run without server delivery state support', () => {
    const delivery = makeDeliveryAdapter({ status: 'delivered' });
    const runner = new DeliveryRunner({
      messaging: makeMessaging([], { serverDeliveryState: false }),
      delivery,
    });

    expect(() => runner.start()).toThrow(RelayCapabilityError);
    expect(() => runner.start()).toThrow(
      'DeliveryRunner requires server-backed delivery state for ack/fail/defer.'
    );
    expect(delivery.inject).not.toHaveBeenCalled();
  });

  it('connects, injects inbox items, and acks delivered results', async () => {
    const item = makeInboxItem('in_1', 'hello');
    const delivery = makeDeliveryAdapter({ status: 'delivered', metadata: { injected: true } });
    const onResult = vi.fn();
    const messaging = makeMessaging([item]);
    const runner = new DeliveryRunner({
      messaging,
      delivery,
      onResult,
    });

    await runner.start();

    expect(delivery.connect).toHaveBeenCalledTimes(1);
    expect(delivery.inject).toHaveBeenCalledWith(item.message, {
      reason: 'message',
      priority: undefined,
      mode: undefined,
    });
    expect(onResult).toHaveBeenCalledWith(item, { status: 'delivered', metadata: { injected: true } });
    expect(messaging.inbox.ack).toHaveBeenCalledWith({
      inboxItemId: 'in_1',
      state: 'delivered',
      metadata: { injected: true },
    });
    expect(delivery.disconnect).toHaveBeenCalledTimes(1);
  });

  it('defers adapter-deferred inbox items', async () => {
    const item = makeInboxItem('in_2', 'later');
    const messaging = makeMessaging([item]);
    const runner = new DeliveryRunner({
      messaging,
      delivery: makeDeliveryAdapter({
        status: 'deferred',
        availableAt: '2026-05-27T11:00:00.000Z',
        reason: 'busy',
        metadata: { queue: 'runtime' },
      }),
    });

    await runner.start();

    expect(messaging.inbox.defer).toHaveBeenCalledWith({
      inboxItemId: 'in_2',
      availableAt: '2026-05-27T11:00:00.000Z',
      reason: 'busy',
      metadata: { queue: 'runtime' },
    });
    expect(messaging.inbox.ack).not.toHaveBeenCalled();
  });

  it('marks inbox items retryable when adapter injection throws', async () => {
    const item = makeInboxItem('in_3', 'boom');
    const messaging = makeMessaging([item]);
    const delivery = makeDeliveryAdapter({ status: 'delivered' });
    vi.mocked(delivery.inject).mockRejectedValueOnce(new Error('adapter unavailable'));
    const onError = vi.fn();
    const runner = new DeliveryRunner({
      messaging,
      delivery,
      onError,
    });

    await runner.start();

    expect(onError).toHaveBeenCalledWith(item, expect.any(Error));
    expect(messaging.inbox.fail).toHaveBeenCalledWith({
      inboxItemId: 'in_3',
      error: 'adapter unavailable',
      retry: true,
    });
  });

  it('can deliver inbox items to a session receiveMessage contract', async () => {
    const item = makeInboxItem('in_4', 'session delivery');
    const session = makeSession({ status: 'delivered', deliveryId: 'del_4' });
    const messaging = makeMessaging([item]);
    const runner = new DeliveryRunner({
      messaging,
      delivery: session,
      context: { mode: 'next-tool-call', reason: 'mention' },
    });

    await runner.start();

    expect(session.receiveMessage).toHaveBeenCalledWith(item.message, {
      id: 'in_4',
      mode: 'next-tool-call',
      reason: 'mention',
      priority: undefined,
      deadline: undefined,
      idempotencyKey: undefined,
      metadata: undefined,
    });
    expect(messaging.inbox.ack).toHaveBeenCalledWith({
      inboxItemId: 'in_4',
      state: 'delivered',
      metadata: undefined,
    });
  });

  it('runs against RelaycastMessagingClient with a durable delivery agent client', async () => {
    const anyHandlers = new Set<(event: unknown) => void>();
    const deliveryRow = (id: string, messageId: string) => ({
      id,
      messageId,
      channelId: 'ch-1',
      agentId: 'agent-1',
      status: 'accepted',
      mode: 'wait',
      reason: 'dm',
      priority: 'normal',
      availableAt: null,
      message: {
        id: messageId,
        channelId: 'ch-1',
        agentId: 'agent-9',
        agentName: 'Lead',
        text: `payload ${id}`,
        threadId: null,
        createdAt: '2026-06-09T10:00:00.000Z',
      },
    });
    const agent = {
      connect: vi.fn(),
      disconnect: vi.fn(async () => {}),
      on: {
        any: vi.fn((handler: (event: unknown) => void) => {
          anyHandlers.add(handler);
          return () => anyHandlers.delete(handler);
        }),
      },
      deliveries: vi.fn(async () => [deliveryRow('del_1', 'm-100')]),
      ackDelivery: vi.fn(async (id: string) => ({ ...deliveryRow(id, 'm-100'), status: 'delivered' })),
      failDelivery: vi.fn(async (id: string) => ({ ...deliveryRow(id, 'm-100'), status: 'failed' })),
      deferDelivery: vi.fn(async (id: string) => ({ ...deliveryRow(id, 'm-100'), status: 'deferred' })),
    };
    const messaging = new RelaycastMessagingClient({
      relaycast: {} as never,
      agentClient: agent as never,
    });
    const delivery = makeDeliveryAdapter({ status: 'delivered' });

    let resolveFirstResult!: () => void;
    const firstResult = new Promise<void>((resolve) => {
      resolveFirstResult = resolve;
    });
    const runner = new DeliveryRunner({
      messaging,
      delivery,
      agentName: 'WorkerA',
      onResult: () => resolveFirstResult(),
    });

    const running = runner.start();
    await firstResult;
    runner.stop();
    // Yield one more item so the subscription loop observes the stop flag.
    agent.deliveries.mockResolvedValue([deliveryRow('del_2', 'm-200')]);
    for (const handler of anyHandlers) {
      handler({ type: 'delivery.accepted', deliveryId: 'del_2', messageId: 'm-200' });
    }
    await running;

    expect(delivery.inject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(delivery.inject).mock.calls[0][0]).toMatchObject({
      id: 'm-100',
      text: 'payload del_1',
    });
    expect(agent.ackDelivery).toHaveBeenCalledWith('del_1');
    expect(agent.failDelivery).not.toHaveBeenCalled();
    expect(agent.deferDelivery).not.toHaveBeenCalled();
  });
});

function makeDeliveryAdapter(result: InjectionResult): AgentDeliveryAdapter {
  return {
    id: 'test-delivery',
    kind: 'test',
    capabilities: {
      push: true,
      interrupt: false,
      detectIdle: false,
      threads: false,
      attachments: false,
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    inject: vi.fn(async () => result),
  };
}

function makeSession(result: Awaited<ReturnType<AgentSession['receiveMessage']>>): AgentSession {
  return {
    identity: normalizeAgentIdentity({ id: 'agent_worker', name: 'worker', handle: '@worker' }),
    capabilities: MINIMAL_AGENT_SESSION_CAPABILITIES,
    receiveMessage: vi.fn(async () => result),
    onEvent: vi.fn(() => () => {}),
    release: vi.fn(async () => {}),
  };
}

function makeMessaging(
  items: InboxItem[],
  capabilities: RelayMessaging['capabilities'] = { serverDeliveryState: true }
): RelayMessaging {
  return {
    capabilities,
    agents: {},
    channels: {},
    messages: {},
    threads: {},
    events: {},
    inbox: {
      list: vi.fn(async () => ({ items })),
      subscribe: vi.fn(() => makeInboxSubscription(items)),
      ack: vi.fn(async () => {}),
      fail: vi.fn(async () => {}),
      defer: vi.fn(async () => {}),
      markRead: vi.fn(async () => {}),
    },
  } as unknown as RelayMessaging;
}

async function* makeInboxSubscription(items: InboxItem[]): AsyncIterable<InboxItem> {
  for (const item of items) {
    yield item;
  }
}

function makeInboxItem(id: string, text: string): InboxItem {
  return {
    id,
    recipient: { name: 'worker' },
    state: 'queued',
    attempts: 0,
    availableAt: '2026-05-27T10:00:00.000Z',
    message: {
      id: `msg_${id}`,
      from: { name: 'lead' },
      target: { kind: 'agent', agentName: 'worker' },
      text,
      createdAt: '2026-05-27T10:00:00.000Z',
    },
  };
}
