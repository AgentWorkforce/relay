import { describe, expect, it, vi } from 'vitest';

import { ActionRegistry } from '../actions/index.js';
import { registerFacadeAction } from '../facade.js';
import type { RelayMessaging } from '../messaging/index.js';

type ActionInvokedHandler = (event: {
  type: 'actionInvoked';
  invocationId: string;
  actionName: string;
  callerName: string;
  handlerAgentId: string;
}) => void | Promise<void>;

/**
 * Build a mock messaging client that exposes the relay action surface plus an
 * `actionInvoked` emitter so tests can drive the fire-and-forget handler loop.
 */
function createRelayMessagingMock(options?: { invocationInput?: Record<string, unknown> }) {
  const invokedHandlers = new Set<ActionInvokedHandler>();

  const register = vi.fn(async (input: unknown) => ({ ...(input as object) }));
  const getInvocation = vi.fn(async (name: string, invocationId: string) => ({
    invocationId,
    actionName: name,
    callerName: 'planner',
    input: options?.invocationInput ?? { model: 'opus' },
    output: null,
    status: 'invoked',
    error: null,
    durationMs: null,
    completedAt: null,
  }));
  const completeInvocation = vi.fn(async (name: string, invocationId: string, data: unknown) => ({
    invocationId,
    actionName: name,
    status: (data as { error?: string }).error ? 'failed' : 'completed',
    output: (data as { output?: Record<string, unknown> }).output ?? null,
    error: (data as { error?: string }).error ?? null,
  }));

  const commands = {
    register,
    list: vi.fn(async () => []),
    delete: vi.fn(async () => {}),
    available: () => true,
    agentScoped: () => true,
    invoke: vi.fn(async (name: string) => ({ invocationId: 'inv_1', actionName: name })),
    getInvocation,
    completeInvocation,
  };

  const events = {
    connect: vi.fn(),
    disconnect: vi.fn(async () => {}),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    on: vi.fn((event: string, handler: ActionInvokedHandler) => {
      if (event === 'actionInvoked') {
        invokedHandlers.add(handler);
        return () => invokedHandlers.delete(handler);
      }
      return () => {};
    }),
  };

  const messaging = { commands, events } as unknown as RelayMessaging;

  const emitInvoked = async (invocationId: string, actionName: string, callerName = 'planner') => {
    for (const handler of invokedHandlers) {
      await handler({
        type: 'actionInvoked',
        invocationId,
        actionName,
        callerName,
        handlerAgentId: 'handler-id',
      });
    }
  };

  return { messaging, commands, events, register, getInvocation, completeInvocation, emitInvoked };
}

describe('registerFacadeAction relay wiring', () => {
  it('registers the descriptor on the relay with converted schema and availableTo', () => {
    const actions = new ActionRegistry();
    const mock = createRelayMessagingMock();

    registerFacadeAction(
      actions,
      {
        name: 'spawn-claude',
        description: 'Spawn a Claude agent',
        availableTo: [{ name: 'planner' }],
        inputSchema: {
          type: 'object',
          properties: { model: { type: 'string' } },
        },
        handler: async () => ({ ok: true }),
      },
      { messaging: mock.messaging, handlerAgent: 'orchestrator' }
    );

    expect(mock.register).toHaveBeenCalledTimes(1);
    expect(mock.register).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'spawn-claude',
        description: 'Spawn a Claude agent',
        handlerAgent: 'orchestrator',
        availableTo: ['planner'],
        inputSchema: { type: 'object', properties: { model: { type: 'string' } } },
      })
    );
    expect(mock.events.on).toHaveBeenCalledWith('actionInvoked', expect.any(Function));
    // The event stream must be opened, or the handler never sees invocations.
    expect(mock.events.connect).toHaveBeenCalled();
  });

  it('runs the local handler and completes with its output on action.invoked', async () => {
    const actions = new ActionRegistry();
    const mock = createRelayMessagingMock({ invocationInput: { model: 'sonnet' } });
    const handler = vi.fn(async ({ input }: { input: { model: string } }) => ({
      spawned: input.model,
    }));

    registerFacadeAction(
      actions,
      { name: 'spawn-claude', handler },
      { messaging: mock.messaging, handlerAgent: 'orchestrator' }
    );

    await mock.emitInvoked('inv_42', 'spawn-claude');

    expect(mock.getInvocation).toHaveBeenCalledWith('spawn-claude', 'inv_42');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { model: 'sonnet' },
        agent: expect.objectContaining({ name: 'planner' }),
      })
    );
    expect(mock.completeInvocation).toHaveBeenCalledWith('spawn-claude', 'inv_42', {
      output: { spawned: 'sonnet' },
    });
  });

  it('completes with an error when the handler throws', async () => {
    const actions = new ActionRegistry();
    const mock = createRelayMessagingMock();

    registerFacadeAction(
      actions,
      {
        name: 'boom',
        handler: async () => {
          throw new Error('handler exploded');
        },
      },
      { messaging: mock.messaging, handlerAgent: 'orchestrator' }
    );

    await mock.emitInvoked('inv_err', 'boom');

    expect(mock.completeInvocation).toHaveBeenCalledWith('boom', 'inv_err', {
      error: 'handler exploded',
    });
  });

  it('ignores invocations for other actions', async () => {
    const actions = new ActionRegistry();
    const mock = createRelayMessagingMock();
    const handler = vi.fn(async () => ({ ok: true }));

    registerFacadeAction(
      actions,
      { name: 'spawn-claude', handler },
      { messaging: mock.messaging, handlerAgent: 'orchestrator' }
    );

    await mock.emitInvoked('inv_x', 'some-other-action');

    expect(handler).not.toHaveBeenCalled();
    expect(mock.completeInvocation).not.toHaveBeenCalled();
  });

  it('unregister stops handling further invocations', async () => {
    const actions = new ActionRegistry();
    const mock = createRelayMessagingMock();
    const handler = vi.fn(async () => ({ ok: true }));

    const registration = registerFacadeAction(
      actions,
      { name: 'spawn-claude', handler },
      { messaging: mock.messaging, handlerAgent: 'orchestrator' }
    );

    registration.unregister();
    await mock.emitInvoked('inv_after', 'spawn-claude');

    expect(handler).not.toHaveBeenCalled();
  });

  it('skips relay wiring when no agent-scoped action surface is present', () => {
    const actions = new ActionRegistry();
    const on = vi.fn();
    const register = vi.fn();
    const messaging = {
      commands: {
        register,
        available: () => true,
        agentScoped: () => false,
      },
      events: { on },
    } as unknown as RelayMessaging;

    const registration = registerFacadeAction(
      actions,
      { name: 'local-only', handler: async () => ({ ok: true }) },
      { messaging, handlerAgent: 'orchestrator' }
    );

    expect(register).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
    expect(actions.has('local-only')).toBe(true);
    registration.unregister();
    expect(actions.has('local-only')).toBe(false);
  });

  it('routes descriptor registration failures to the wiring onError hook', async () => {
    const { messaging } = createRelayMessagingMock();
    const failure = new Error('relay rejected the descriptor');
    (
      messaging.commands.register as unknown as { mockRejectedValueOnce: (e: Error) => void }
    ).mockRejectedValueOnce(failure);
    const onError = vi.fn();
    const actions = new ActionRegistry();

    registerFacadeAction(
      actions,
      { name: 'spawn-claude', handler: async () => ({ ok: true }) },
      { messaging, handlerAgent: 'orchestrator', onError }
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).toHaveBeenCalledWith(failure, {
      source: 'action',
      action: 'spawn-claude',
      operation: 'register',
    });
  });

  it('registers locally with no wiring at all (legacy behavior)', async () => {
    const actions = new ActionRegistry();
    const handler = vi.fn(async () => ({ ok: true }));

    registerFacadeAction(actions, { name: 'plain', handler });

    expect(actions.has('plain')).toBe(true);
    const result = await actions.invoke({
      name: 'plain',
      input: {},
      caller: { name: 'p', type: 'agent' },
    });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
