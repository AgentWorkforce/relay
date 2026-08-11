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
function makeRelayRejectingAgent(err: Error = new Error('not found')) {
  return () =>
    ({
      agents: { get: vi.fn(async () => Promise.reject(err)) },
      nodes: { list: vi.fn(async () => []) },
    }) as never;
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
