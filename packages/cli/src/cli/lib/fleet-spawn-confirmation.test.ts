import { RelayPlacementError, RelaycastMessagingClient } from '@agent-relay/sdk';
import { describe, expect, it, vi } from 'vitest';

/**
 * Gated proof for issue #1430.
 *
 * These arms live here, under `packages/cli`, rather than beside the other
 * placement tests in `packages/sdk/src/messaging/placement.test.mts`, because
 * the root vitest config — the only JS suite CI runs — excludes
 * `packages/sdk/**`. The load-bearing arms have to sit in a suite that actually
 * runs, or a later refactor reverts the fix with CI green, which is the very
 * failure shape this change exists to prevent.
 *
 * Every arm is a deterministic requester-level fixture. None of them touches a
 * real node, and none of them passes merely because a node replied correctly —
 * the point under test is that the REQUESTER distinguishes "the node executed
 * and confirmed" from "the engine accepted the dispatch".
 */

const LIVE_NODE = {
  id: 'node_a',
  name: 'node-a',
  status: 'online',
  live: true,
  capabilities: [{ name: 'spawn:claude', kind: 'spawn' }],
  repo_keys: ['relay'],
};

function createClient(getInvocation?: (name: string, invocationId: string) => Promise<unknown>) {
  const invoke = vi.fn(async (name: string, input?: Record<string, unknown>) => ({
    invocation_id: 'inv-1430',
    action_name: name,
    handler_node_id: 'node_a',
    dispatched_node_id: 'node_a',
    input,
    // The engine accepted the dispatch. This is all the requester ever knew
    // before this change, and it is identical whether or not anything launched.
    status: 'invoked',
  }));
  const reader = vi.fn(getInvocation ?? (async () => undefined));
  const relaycast = {
    agents: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      presence: vi.fn(async () => []),
    },
    channels: { list: vi.fn(async () => []), get: vi.fn() },
    messages: { list: vi.fn(async () => []), get: vi.fn(), thread: vi.fn(), reactions: vi.fn() },
    nodes: {
      list: vi.fn(async () => [LIVE_NODE]),
      get: vi.fn(async () => LIVE_NODE),
    },
  };
  const agentClient = {
    actions: { invoke, getInvocation: reader, completeInvocation: vi.fn() },
  };
  const client = new RelaycastMessagingClient({
    relaycast: relaycast as never,
    agentClient: agentClient as never,
    placementTtlMs: 60,
  });
  return { client, invoke, reader };
}

function spawnInput(overrides: Record<string, unknown> = {}) {
  return {
    capability: 'spawn:claude',
    node: 'node-a',
    repo: 'relay',
    input: { name: 'worker-1430' },
    ...overrides,
  };
}

describe('fleet spawn confirmation is observable from the requester (#1430)', () => {
  // MUST-FIRE — the sf-mini shape. A node advertised `spawn:claude` capacity,
  // accepted the invocation, and launched nothing; the invocation therefore
  // never reaches a terminal state. Before this change the requester returned a
  // successful placement ack here. Silence must now be a failure.
  it('fails with spawn_unconfirmed when the node accepts but never reports a result', async () => {
    const { client, reader } = createClient(async (name, invocationId) => ({
      invocation_id: invocationId,
      action_name: name,
      status: 'invoked',
    }));

    const error = await client.placement
      .spawn(spawnInput({ confirm: true, confirmTimeoutMs: 60, confirmPollIntervalMs: 10 }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelayPlacementError);
    expect((error as RelayPlacementError).code).toBe('spawn_unconfirmed');
    expect((error as RelayPlacementError).node).toBe('node-a');
    expect((error as Error).message).toContain('never reported a result');
    expect(reader).toHaveBeenCalled();
  });

  // MUST-FIRE — a node that reports its failure honestly still surfaced as
  // success before this change, because nothing read the action result. The
  // broker's detail (startup exit status and worker log path) must survive.
  it('fails with spawn_failed and preserves the node-reported detail', async () => {
    const { client } = createClient(async (name, invocationId) => ({
      invocation_id: invocationId,
      action_name: name,
      status: 'failed',
      error:
        "spawn_failed: agent 'worker-1430' process exited during startup (exit status: 19); see worker log /tmp/worker-1430.log",
    }));

    const error = await client.placement
      .spawn(spawnInput({ confirm: true, confirmTimeoutMs: 1_000, confirmPollIntervalMs: 10 }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelayPlacementError);
    expect((error as RelayPlacementError).code).toBe('spawn_failed');
    expect((error as Error).message).toContain('exit status: 19');
    expect((error as Error).message).toContain('/tmp/worker-1430.log');
  });

  // MUST-NOT-FIRE — a healthy node. This is the arm a repaired node represents:
  // confirmation must not turn a working spawn into an error.
  it('resolves when the node confirms the spawn completed', async () => {
    const { client } = createClient(async (name, invocationId) => ({
      invocation_id: invocationId,
      action_name: name,
      status: 'completed',
      output: { spawned: true, name: 'worker-1430' },
    }));

    const ack = await client.placement.spawn(
      spawnInput({ confirm: true, confirmTimeoutMs: 1_000, confirmPollIntervalMs: 10 })
    );

    expect(ack.placement.confirmed).toBe(true);
    expect(ack.confirmation?.status).toBe('completed');
  });

  // VACUITY CONTROL — without `confirm` the invocation is never read back, so
  // the three arms above cannot be passing for some incidental reason. This is
  // also the documented behaviour of the generic primitive: `placement.spawn`
  // dispatches non-spawn capabilities too, so it does not wait by default.
  it('does not read the invocation at all when confirmation is not requested', async () => {
    const { client, reader } = createClient();

    const ack = await client.placement.spawn(spawnInput());

    expect(reader).not.toHaveBeenCalled();
    expect(ack.placement.confirmed).toBe(false);
    expect(ack.confirmation).toBeUndefined();
  });

  // An engine that cannot answer at all is not evidence of success either.
  it('fails with spawn_unconfirmed when the invocation cannot be read', async () => {
    const { client } = createClient(async () => {
      throw new Error('getInvocation is not supported by this engine');
    });

    const error = await client.placement
      .spawn(spawnInput({ confirm: true, confirmTimeoutMs: 60, confirmPollIntervalMs: 10 }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RelayPlacementError);
    expect((error as RelayPlacementError).code).toBe('spawn_unconfirmed');
    expect((error as Error).message).toContain('getInvocation is not supported');
  });
});
