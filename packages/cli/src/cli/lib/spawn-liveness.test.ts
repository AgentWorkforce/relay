import { describe, expect, it, vi } from 'vitest';
import { RelayPlacementError, type RelayNode } from '@agent-relay/sdk';
import {
  classifySpawnFailure,
  mayStillBeRunning,
  pendingSpawnError,
  probeSpawnLiveness,
  terminalSpawnOutcome,
} from './spawn-liveness.js';

const now = Date.parse('2026-10-04T12:00:00Z');
const node = (name = 'target', age = 0): RelayNode => ({
  name,
  status: 'online',
  lastHeartbeatAt: new Date(now - age).toISOString(),
  capabilities: [{ name: 'relay:live-agents:v1', metadata: { names: ['worker'] } }],
});
function client(nodes: RelayNode[] = []) {
  return {
    nodes: {
      get: vi.fn(async (name: string) => nodes.find((n) => n.name === name) ?? null),
      list: vi.fn(async () => nodes),
    },
    agents: {
      get: vi.fn(async (): Promise<unknown> => {
        throw { status: 404 };
      }),
    },
  };
}

describe('spawn liveness resolution', () => {
  it.each([
    [node(), 'live'],
    [node('other'), 'live_elsewhere'],
    [node('target', 36_001), 'stale'],
    [{ ...node(), lastHeartbeatAt: undefined }, 'stale'],
    [{ ...node(), status: 'offline' }, 'absent'],
  ] as const)('requires fresh target-node evidence (%j)', async (record, evidence) => {
    const workspace = client([record]);
    expect(
      await probeSpawnLiveness({
        name: 'worker',
        targetNode: 'target',
        createClient: () => workspace,
        now: () => now,
      })
    ).toMatchObject({ evidence });
    if (evidence === 'live') expect(workspace.nodes.list).not.toHaveBeenCalled();
  });
  it('folds construction errors into unknown without replacing accepted dispatch evidence', async () => {
    const result = await probeSpawnLiveness({
      name: 'worker',
      createClient: () => {
        throw new Error('no key');
      },
    });
    expect(result).toEqual({ evidence: 'unknown', readError: 'no key' });
    const pending = pendingSpawnError('worker', { invocationId: 'inv', dispatchState: 'dispatched' }, result);
    expect(pending.exitCode).toBe(8);
    expect(pending.message).toContain('--wait');
    expect(pending.message).not.toContain('failed');
    expect(mayStillBeRunning(pending)).toBe(true);
  });
  it('preserves SDK unconfirmed errors as potentially running', () => {
    expect(
      mayStillBeRunning(
        new RelayPlacementError('spawn_unconfirmed', 'pending', {
          capability: 'spawn',
          attempts: 1,
          state: 'unconfirmed_may_be_running',
        })
      )
    ).toBe(true);
    expect(mayStillBeRunning(new Error('failure'))).toBe(false);
  });
  it('reads the invocation before constructing a workspace client', async () => {
    const createClient = vi.fn(() => {
      throw new Error('no key');
    });
    const invocation = { status: 'completed', output: { spawned: true, ready: false } };
    const result = await probeSpawnLiveness({
      name: 'worker',
      getInvocation: async () => invocation,
      createClient,
    });
    expect(result).toEqual({ evidence: 'invocation_terminal', invocation });
    expect(createClient).not.toHaveBeenCalled();
    expect(terminalSpawnOutcome(invocation, {}, false)).toMatchObject({ placement: { confirmed: true } });
    expect(() => terminalSpawnOutcome(invocation, {}, true)).toThrow('proof');
    expect(() => terminalSpawnOutcome({ status: 'failed', error: 'launch error' }, {}, false)).toThrow(
      'launch error'
    );
  });
  it('distinguishes registered, absent and unavailable reads', async () => {
    const workspace = client();
    workspace.agents.get.mockResolvedValueOnce({ status: 'released' });
    expect(await probeSpawnLiveness({ name: 'worker', createClient: () => workspace })).toMatchObject({
      evidence: 'registered',
    });
    expect(await probeSpawnLiveness({ name: 'worker', createClient: () => workspace })).toMatchObject({
      evidence: 'absent',
    });
    workspace.agents.get.mockRejectedValueOnce(new Error('403 forbidden'));
    expect(await probeSpawnLiveness({ name: 'worker', createClient: () => workspace })).toMatchObject({
      evidence: 'unknown',
    });
  });
  it('bounds a hung invocation read and still probes worker evidence', async () => {
    vi.useFakeTimers();
    try {
      const result = probeSpawnLiveness({
        name: 'worker',
        getInvocation: () => new Promise(() => {}),
        createClient: () => client([node()]),
        now: () => now,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toMatchObject({ evidence: 'live' });
    } finally {
      vi.useRealTimers();
    }
  });
  it('classifies only broker pre-registration collisions', () => {
    expect(
      classifySpawnFailure(
        "failed to pre-register worker 'worker': agent 'worker' already exists and registration is create-only; use a unique agent name"
      )
    ).toBe('spawn_name_taken');
    expect(classifySpawnFailure('failed to create sandbox: directory already exists')).toBeUndefined();
    expect(classifySpawnFailure("failed to pre-register worker 'worker': cache entry already exists")).toBeUndefined();
  });
});
