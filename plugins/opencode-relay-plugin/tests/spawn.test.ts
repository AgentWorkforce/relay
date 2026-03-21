import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RelayState,
  type SpawnLike,
  createRelayDismissTool,
  createRelaySpawnTool,
} from '../src/index.js';
import {
  MockRelayServer,
  connectRelayState,
  createMockFetch,
} from './mock-relay-server.js';

class FakeChildProcess extends EventEmitter implements Pick<ChildProcess, 'kill' | 'pid'> {
  pid: number;
  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

describe('OpenCode relay spawn and dismiss tools', () => {
  let server: MockRelayServer;

  beforeEach(() => {
    server = new MockRelayServer();
    vi.stubGlobal('fetch', createMockFetch(server) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('spawns an OpenCode worker with the relay bootstrap prompt and env vars', async () => {
    const state = connectRelayState(new RelayState());
    const proc = new FakeChildProcess(4242);
    const spawnMock = vi.fn<SpawnLike>(
      (command: string, args?: readonly string[], options?: SpawnOptions) => {
        expect(command).toBe('opencode');
        expect(args).toEqual([
          '--prompt',
          [
            'You are Researcher, a worker agent on Agent Relay.',
            'Your task: Investigate the auth module',
            '',
            'IMPORTANT: At the start, call relay_connect with:',
            '  workspace: (read from RELAY_WORKSPACE env var)',
            '  name: "Researcher"',
            '',
            'Then send a DM to "Lead" with "ACK: <your understanding of the task>".',
            'When done, send "DONE: <summary>" to "Lead".',
          ].join('\n'),
          '--dir',
          '/tmp/project',
          '--model',
          'claude-sonnet-4-6',
        ]);
        expect(options).toMatchObject({
          cwd: '/tmp/project',
          stdio: 'pipe',
          detached: true,
        });
        expect(options?.env?.RELAY_WORKSPACE).toBe('rk_live_test_workspace');
        expect(options?.env?.RELAY_AGENT_NAME).toBe('Researcher');
        expect(JSON.stringify(args)).not.toContain('rk_live_test_workspace');
        return proc as unknown as ChildProcess;
      }
    );

    const result = await createRelaySpawnTool(state, { spawn: spawnMock }).handler({
      name: 'Researcher',
      task: 'Investigate the auth module',
      dir: '/tmp/project',
      model: 'claude-sonnet-4-6',
    });

    expect(result).toEqual({
      spawned: true,
      name: 'Researcher',
      pid: 4242,
      hint: 'Worker "Researcher" is starting. It will ACK via DM when ready.',
    });
    expect(server.requests[0]).toMatchObject({
      endpoint: 'agent/add',
      body: {
        name: 'Researcher',
        cli: 'opencode',
        task: 'Investigate the auth module',
      },
    });
    expect(state.spawned.get('Researcher')).toMatchObject({
      name: 'Researcher',
      task: 'Investigate the auth module',
      status: 'running',
    });

    proc.emit('exit', 0);

    expect(state.spawned.get('Researcher')?.status).toBe('done');
  });

  it('marks a spawned worker as errored when the process exits non-zero', async () => {
    const state = connectRelayState(new RelayState());
    const proc = new FakeChildProcess(5050);
    const spawnMock = vi.fn<SpawnLike>(() => proc as unknown as ChildProcess);

    await createRelaySpawnTool(state, { spawn: spawnMock }).handler({
      name: 'Implementer',
      task: 'Patch the auth module',
    });

    proc.emit('exit', 1);

    expect(state.spawned.get('Implementer')?.status).toBe('error');
  });

  it('dismisses a running worker by killing the process and removing it from relay state', async () => {
    const state = connectRelayState(new RelayState());
    const proc = new FakeChildProcess(6060);

    state.spawned.set('Researcher', {
      name: 'Researcher',
      process: proc as unknown as ChildProcess,
      task: 'Investigate the auth module',
      status: 'running',
    });

    const result = await createRelayDismissTool(state).handler({
      name: 'Researcher',
    });

    expect(result).toEqual({ dismissed: true, name: 'Researcher' });
    expect(proc.killSignals).toEqual(['SIGTERM']);
    expect(server.requests[0]).toMatchObject({
      endpoint: 'agent/remove',
      body: { name: 'Researcher' },
    });
    expect(state.spawned.has('Researcher')).toBe(false);
  });

  it('dismisses an already-finished worker without killing it again', async () => {
    const state = connectRelayState(new RelayState());
    const proc = new FakeChildProcess(7070);

    state.spawned.set('Researcher', {
      name: 'Researcher',
      process: proc as unknown as ChildProcess,
      task: 'Investigate the auth module',
      status: 'done',
    });

    await createRelayDismissTool(state).handler({
      name: 'Researcher',
    });

    expect(proc.killSignals).toEqual([]);
    expect(server.requests[0]).toMatchObject({
      endpoint: 'agent/remove',
      body: { name: 'Researcher' },
    });
    expect(state.spawned.has('Researcher')).toBe(false);
  });
});
