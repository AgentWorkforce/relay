import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import relayPlugin, {
  RelayState,
  type SpawnLike,
  createRelayConnectTool,
  createRelayInboxTool,
  createRelaySendTool,
  createRelaySpawnTool,
} from '../src/index.js';
import {
  MockRelayServer,
  connectRelayState,
  createMockFetch,
  createPluginContext,
} from './mock-relay-server.js';

class FakeChildProcess extends EventEmitter implements Pick<ChildProcess, 'kill' | 'pid'> {
  pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    return true;
  }
}

describe('Integration tests', () => {
  let server: MockRelayServer;

  beforeEach(() => {
    server = new MockRelayServer();
    vi.stubGlobal('fetch', createMockFetch(server) as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('round-trip: connect, send a DM, then receive it via inbox', async () => {
    const state = new RelayState();

    // Connect
    await createRelayConnectTool(state).handler({
      workspace: 'rk_live_test_workspace',
      name: 'Alice',
    });
    expect(state.connected).toBe(true);

    // Send a DM
    await createRelaySendTool(state).handler({
      to: 'Bob',
      text: 'Hello from Alice',
    });

    // Simulate Bob replying (inject a message into the mock server)
    server.injectMessage('Bob', 'Hello back from Bob');

    // Check inbox
    const inbox = await createRelayInboxTool(state).handler({});
    expect(inbox.count).toBeGreaterThanOrEqual(1);

    const bobMessage = inbox.messages.find((m) => m.from === 'Bob');
    expect(bobMessage).toBeDefined();
    expect(bobMessage?.text).toBe('Hello back from Bob');

    // Second check should be empty (messages consumed)
    const secondCheck = await createRelayInboxTool(state).handler({});
    expect(secondCheck.count).toBe(0);
  });

  it('spawn-ack-flow: spawn worker, worker ACKs, worker sends DONE, dismiss', async () => {
    const state = connectRelayState(new RelayState());
    const proc = new FakeChildProcess(9999);
    const spawnMock = vi.fn<SpawnLike>(() => proc as unknown as ChildProcess);

    // Spawn a worker
    const spawnResult = await createRelaySpawnTool(state, { spawn: spawnMock }).handler({
      name: 'Worker-1',
      task: 'Fix the auth bug',
    });

    expect(spawnResult.spawned).toBe(true);
    expect(spawnResult.name).toBe('Worker-1');
    expect(state.spawned.get('Worker-1')?.status).toBe('running');

    // Simulate worker sending ACK
    server.injectMessage('Worker-1', 'ACK: I understand — fixing the auth bug in middleware.ts');

    // Lead checks inbox and sees the ACK
    const ackInbox = await createRelayInboxTool(state).handler({});
    const ackMessage = ackInbox.messages.find(
      (m) => m.from === 'Worker-1' && m.text.startsWith('ACK:')
    );
    expect(ackMessage).toBeDefined();

    // Simulate worker sending DONE
    server.injectMessage('Worker-1', 'DONE: Fixed token expiry check in auth/middleware.ts');

    // Lead checks inbox and sees the DONE
    const doneInbox = await createRelayInboxTool(state).handler({});
    const doneMessage = doneInbox.messages.find(
      (m) => m.from === 'Worker-1' && m.text.startsWith('DONE:')
    );
    expect(doneMessage).toBeDefined();

    // Worker process exits successfully
    proc.emit('exit', 0);
    expect(state.spawned.get('Worker-1')?.status).toBe('done');

    // Dismiss the worker
    const { createRelayDismissTool } = await import('../src/index.js');
    const dismissResult = await createRelayDismissTool(state).handler({
      name: 'Worker-1',
    });

    expect(dismissResult.dismissed).toBe(true);
    expect(state.spawned.has('Worker-1')).toBe(false);

    // Verify the full sequence of API calls
    const endpoints = server.requests.map((r) => r.endpoint);
    expect(endpoints).toContain('agent/add');
    expect(endpoints).toContain('inbox/check');
    expect(endpoints).toContain('agent/remove');
  });
});
