import { describe, expect, it, vi } from 'vitest';

import { resolveFleetHint } from './fleet-hint.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a stub relay factory where agents.get() returns the given metadata
 *  and nodes.list() returns the given roster. */
function makeRelay(agentMetadata: unknown, nodes: unknown[] = []) {
  return () =>
    ({
      agents: {
        get: vi.fn(async () => ({ metadata: agentMetadata })),
      },
      nodes: {
        list: vi.fn(async () => nodes),
      },
    }) as never;
}

/** Build a stub where agents.get() rejects — simulates 404 or network error. */
function makeRelayRejectingAgent(err: Error = new Error('not found'), nodes: unknown[] = []) {
  return () =>
    ({
      agents: { get: vi.fn(async () => Promise.reject(err)) },
      nodes: { list: vi.fn(async () => nodes) },
    }) as never;
}

/** A roster node advertising the worker names its broker is running.
 *  Online by default; pass `{ status: 'offline' }` (or `live: false`) for a
 *  history record, which still carries its last heartbeat's worker names. */
function nodeRunning(name: string | undefined, workers: string[], extra: Record<string, unknown> = {}) {
  return {
    name,
    nodeId: 'node_live',
    status: 'online',
    capabilities: [{ name: 'relay:live-agents:v1', metadata: { names: workers } }],
    ...extra,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('resolveFleetHint', () => {
  it('returns null when the agent has no fleet metadata', async () => {
    const result = await resolveFleetHint('ghost', makeRelay({}));
    expect(result).toBeNull();
  });

  it('returns null when agents.get throws (agent not in registry)', async () => {
    const result = await resolveFleetHint('ghost', makeRelayRejectingAgent());
    expect(result).toBeNull();
  });

  it('returns null when fleet object is present but nodeId is missing', async () => {
    const result = await resolveFleetHint('agent', makeRelay({ fleet: { invocationId: null } }));
    expect(result).toBeNull();
  });

  it('returns named-node hint when agent has fleet.nodeId and node is in roster', async () => {
    const result = await resolveFleetHint(
      'my-agent',
      makeRelay({ fleet: { nodeId: 'node_abc123' } }, [{ nodeId: 'node_abc123', name: 'finn-mini' }])
    );
    expect(result).toBe("on node 'finn-mini'");
  });

  it('matches node by id field when nodeId field is absent', async () => {
    const result = await resolveFleetHint(
      'my-agent',
      makeRelay({ fleet: { nodeId: 'node_abc123' } }, [{ id: 'node_abc123', name: 'barry' }])
    );
    expect(result).toBe("on node 'barry'");
  });

  it('falls back to raw nodeId hint when node roster lookup throws', async () => {
    const createRelay = () =>
      ({
        agents: {
          get: vi.fn(async () => ({ metadata: { fleet: { nodeId: 'node_xyz' } } })),
        },
        nodes: {
          list: vi.fn(async () => Promise.reject(new Error('network error'))),
        },
      }) as never;
    const result = await resolveFleetHint('my-agent', createRelay);
    expect(result).toBe("on node 'node_xyz'");
  });

  it('falls back to raw nodeId when no matching node is found in roster', async () => {
    const result = await resolveFleetHint(
      'my-agent',
      makeRelay({ fleet: { nodeId: 'node_unknown' } }, [{ nodeId: 'node_other', name: 'sf-mini' }])
    );
    expect(result).toBe("on node 'node_unknown'");
  });

  it('returns null when createRelay throws (no credentials)', async () => {
    const result = await resolveFleetHint('ghost', () => {
      throw new Error('no credentials');
    });
    expect(result).toBeNull();
  });

  it('returns null when metadata is null', async () => {
    const result = await resolveFleetHint('ghost', makeRelay(null));
    expect(result).toBeNull();
  });
});

describe('resolveFleetHint — workers that are not workspace-registered (relay#1597)', () => {
  it('relay#1597 MUST-FIRE: names the node for a live worker the agent registry does not know', async () => {
    // This is the case the hint exists for and the one it could not answer.
    // A broker-spawned worker on a fleet node is NOT in the workspace agent
    // registry, so `agents.get` 404s and the old code returned null — leaving
    // attach to say "no agent named X" about an agent that is demonstrably
    // alive on another machine. Nodes advertise their live worker set on the
    // heartbeat, so the roster call the hint already makes can answer it.
    // Restore the early `return null` in the agents.get catch and this fails.
    const result = await resolveFleetHint(
      'sandbox-lead-claude-0820b',
      makeRelayRejectingAgent(new Error('404'), [
        nodeRunning('barry', ['other-agent']),
        nodeRunning('sf-mini', ['sandbox-lead-claude-0820b', 'wedge-probe']),
      ])
    );
    expect(result).toBe("on node 'sf-mini'");
  });

  it('relay#1597 MUST-NOT-FIRE: no hint when no node is running that worker', async () => {
    // The hint must stay silent for a name that genuinely does not exist —
    // inventing a placement would be worse than the plain "no agent named X".
    const result = await resolveFleetHint(
      'ghost',
      makeRelayRejectingAgent(new Error('404'), [
        nodeRunning('sf-mini', ['someone-else']),
        nodeRunning('barry', []),
      ])
    );
    expect(result).toBeNull();
  });

  it('does not match a different worker on the same node', async () => {
    const result = await resolveFleetHint(
      'lead',
      makeRelayRejectingAgent(new Error('404'), [nodeRunning('sf-mini', ['lead-2', 'sub-lead'])])
    );
    expect(result).toBeNull();
  });

  it('falls back to the node id, and never to an empty label', async () => {
    // A node with a usable id but no name still produces an actionable hint.
    expect(
      await resolveFleetHint(
        'worker',
        makeRelayRejectingAgent(new Error('404'), [nodeRunning(undefined, ['worker'])])
      )
    ).toBe("on node 'node_live'");

    // A node with no identifier at all must produce no hint rather than
    // "on node 'undefined'", which reads as a bug to the operator.
    expect(
      await resolveFleetHint(
        'worker',
        makeRelayRejectingAgent(new Error('404'), [
          {
            capabilities: [{ name: 'relay:live-agents:v1', metadata: { names: ['worker'] } }],
          },
        ])
      )
    ).toBeNull();
  });

  it('still prefers the registry placement when the agent IS registered', async () => {
    // The roster scan is a fallback, not a replacement: an agent whose
    // registry metadata names its node must keep using that, so the two
    // sources cannot disagree about a registered agent.
    const result = await resolveFleetHint(
      'my-agent',
      makeRelay({ fleet: { nodeId: 'node_abc123' } }, [
        { nodeId: 'node_abc123', name: 'finn-mini' },
        nodeRunning('sf-mini', ['my-agent']),
      ])
    );
    expect(result).toBe("on node 'finn-mini'");
  });

  it('survives a roster lookup failure without throwing', async () => {
    const relay = () =>
      ({
        agents: { get: vi.fn(async () => Promise.reject(new Error('404'))) },
        nodes: { list: vi.fn(async () => Promise.reject(new Error('network'))) },
      }) as never;
    await expect(resolveFleetHint('worker', relay)).resolves.toBeNull();
  });
});

describe('resolveFleetHint — only live nodes can answer', () => {
  it('MUST-NOT-FIRE: ignores an offline node still advertising the worker', () => {
    // `nodes.list()` returns history too, and an offline record keeps the
    // live-agent names from its last heartbeat. Naming that machine would tell
    // the operator to go run a command somewhere the agent is not — a
    // confidently wrong answer, which is worse than the plain message.
    return expect(
      resolveFleetHint(
        'worker',
        makeRelayRejectingAgent(new Error('404'), [
          nodeRunning('dead-node', ['worker'], { status: 'offline' }),
        ])
      )
    ).resolves.toBeNull();
  });

  it('MUST-NOT-FIRE: ignores a node whose handlers are not live', async () => {
    expect(
      await resolveFleetHint(
        'worker',
        makeRelayRejectingAgent(new Error('404'), [
          nodeRunning('half-up', ['worker'], { handlersLive: false }),
        ])
      )
    ).toBeNull();
  });

  it("MUST-NOT-FIRE: ignores a 'direct' pseudo-node", async () => {
    expect(
      await resolveFleetHint(
        'worker',
        makeRelayRejectingAgent(new Error('404'), [nodeRunning('pseudo', ['worker'], { tags: ['direct'] })])
      )
    ).toBeNull();
  });

  it('picks the live node when a stale record lists the same worker', async () => {
    // Ordering must not decide this: a stale record appearing first in the
    // roster must not win over the machine actually running the agent.
    const result = await resolveFleetHint(
      'worker',
      makeRelayRejectingAgent(new Error('404'), [
        nodeRunning('stale-node', ['worker'], { status: 'offline', nodeId: 'node_stale' }),
        nodeRunning('sf-mini', ['worker']),
      ])
    );
    expect(result).toBe("on node 'sf-mini'");
  });
});
