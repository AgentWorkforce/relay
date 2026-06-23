import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayState, type HookHandler } from '../src/index.js';
import { registerHooks } from '../src/hooks.js';
import type { InboxResponse } from '@relaycast/sdk';

type HookRegistry = Record<string, HookHandler>;
type HookRegistrationContext = {
  hook(name: string, handler: HookHandler): void;
};

function createContext(): { ctx: HookRegistrationContext; hooks: HookRegistry } {
  const hooks: HookRegistry = {};

  return {
    ctx: {
      hook(name, handler) {
        hooks[name] = handler;
      },
    },
    hooks,
  };
}

function emptyInbox(): InboxResponse {
  return {
    unreadChannels: [],
    mentions: [],
    unreadDms: [],
    recentReactions: [],
  } as unknown as InboxResponse;
}

function createConnectedState(inbox: () => Promise<InboxResponse>): {
  state: RelayState;
  inboxMock: ReturnType<typeof vi.fn>;
} {
  const state = new RelayState();
  state.connected = true;
  state.agentName = 'Lead';
  state.workspace = 'rk_live_1234567890abcdef';
  state.token = 'tok_test';
  const inboxMock = vi.fn(inbox);
  state.agent = { inbox: inboxMock } as unknown as RelayState['agent'];
  return { state, inboxMock };
}

describe('OpenCode relay hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T15:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('idle-no-messages', async () => {
    const { ctx, hooks } = createContext();
    const { state, inboxMock } = createConnectedState(async () => emptyInbox());
    registerHooks(ctx, state);

    const firstResult = await hooks['session.idle']();
    const secondResult = await hooks['session.idle']();
    vi.advanceTimersByTime(3_000);
    const thirdResult = await hooks['session.idle']();

    expect(firstResult).toBeUndefined();
    expect(secondResult).toBeUndefined();
    expect(thirdResult).toBeUndefined();
    // Second call is throttled by the watermark; only the 1st and 3rd poll.
    expect(inboxMock).toHaveBeenCalledTimes(2);
  });

  it('idle-surfaces-messages', async () => {
    const inbox: InboxResponse = {
      unreadChannels: [],
      mentions: [
        {
          id: 'msg-2',
          channelName: 'general',
          agentName: 'bob',
          text: 'Standup in five minutes.',
          createdAt: '2026-03-13T15:00:01Z',
        },
      ],
      unreadDms: [
        {
          conversationId: 'conv-alice',
          from: 'alice',
          unreadCount: 1,
          lastMessage: {
            id: 'msg-1',
            text: 'Please review auth middleware.',
            createdAt: '2026-03-13T15:00:00Z',
          },
        },
      ],
      recentReactions: [],
    } as unknown as InboxResponse;

    const { ctx, hooks } = createContext();
    const { state } = createConnectedState(async () => inbox);
    registerHooks(ctx, state);

    await expect(hooks['session.idle']()).resolves.toEqual({
      inject:
        'Relay message from bob [#general]: Standup in five minutes.\n\n' +
        'Relay message from alice: Please review auth middleware.',
      continue: true,
    });
  });

  it('idle-swallows-errors', async () => {
    const { ctx, hooks } = createContext();
    const { state } = createConnectedState(async () => {
      throw new Error('boom');
    });
    registerHooks(ctx, state);

    await expect(hooks['session.idle']()).resolves.toBeUndefined();
  });

  it('compacting-preserves', async () => {
    const { ctx, hooks } = createContext();
    const { state } = createConnectedState(async () => emptyInbox());
    state.spawned.set('worker-a', {
      name: 'worker-a',
      process: { kill: vi.fn().mockReturnValue(true) },
      task: 'Review auth',
      status: 'running',
    });
    state.spawned.set('worker-b', {
      name: 'worker-b',
      process: { kill: vi.fn().mockReturnValue(true) },
      task: 'Write tests',
      status: 'done',
    });
    registerHooks(ctx, state);

    await expect(hooks['session.compacting']()).resolves.toEqual({
      preserve: [
        '## Relay State (preserve across compaction)',
        '- Connected as: Lead',
        '- Workspace: rk_live_12345678...',
        '- Spawned workers:',
        '  - worker-a: running - "Review auth"',
        '  - worker-b: done - "Write tests"',
      ].join('\n'),
    });
  });

  it('end-cleanup', async () => {
    const runningKill = vi.fn().mockReturnValue(true);
    const doneKill = vi.fn().mockReturnValue(true);

    const { ctx, hooks } = createContext();
    const { state } = createConnectedState(async () => emptyInbox());
    state.spawned.set('worker-a', {
      name: 'worker-a',
      process: { kill: runningKill },
      task: 'Review auth',
      status: 'running',
    });
    state.spawned.set('worker-b', {
      name: 'worker-b',
      process: { kill: doneKill },
      task: 'Summarize findings',
      status: 'done',
    });
    registerHooks(ctx, state);

    await expect(hooks['session.end']()).resolves.toBeUndefined();

    expect(runningKill).toHaveBeenCalledWith('SIGTERM');
    expect(doneKill).not.toHaveBeenCalled();
    expect(state.connected).toBe(false);
  });
});
