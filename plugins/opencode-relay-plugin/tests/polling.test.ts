import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayState, type HookHandler } from '../src/index.js';
import { registerHooks } from '../src/hooks.js';

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

function createConnectedState(): RelayState {
  const state = new RelayState();
  state.connected = true;
  state.agentName = 'Lead';
  state.workspace = 'rk_live_1234567890abcdef';
  state.token = 'tok_test';
  return state;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('OpenCode relay hooks', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T15:00:00Z'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('idle-no-messages', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [] }));

    const { ctx, hooks } = createContext();
    const state = createConnectedState();
    registerHooks(ctx, state);

    const firstResult = await hooks['session.idle']();
    const secondResult = await hooks['session.idle']();
    vi.advanceTimersByTime(3_000);
    const thirdResult = await hooks['session.idle']();

    expect(firstResult).toBeUndefined();
    expect(secondResult).toBeUndefined();
    expect(thirdResult).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://www.relaycast.dev/api/v1/inbox/check',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok_test',
        },
        body: '{}',
      }
    );
  });

  it('idle-surfaces-messages', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        messages: [
          {
            id: 'msg-1',
            from: 'alice',
            text: 'Please review auth middleware.',
            ts: '2026-03-13T15:00:00Z',
          },
          {
            id: 'msg-2',
            from: 'bob',
            channel: 'general',
            text: 'Standup in five minutes.',
            ts: '2026-03-13T15:00:01Z',
          },
        ],
      })
    );

    const { ctx, hooks } = createContext();
    const state = createConnectedState();
    registerHooks(ctx, state);

    await expect(hooks['session.idle']()).resolves.toEqual({
      inject:
        'Relay message from alice: Please review auth middleware.\n\n' +
        'Relay message from bob [#general]: Standup in five minutes.',
      continue: true,
    });
  });

  it('compacting-preserves', async () => {
    const { ctx, hooks } = createContext();
    const state = createConnectedState();
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
    const state = createConnectedState();
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
