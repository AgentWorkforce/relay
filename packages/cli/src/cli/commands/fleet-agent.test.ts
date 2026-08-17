import { describe, expect, it } from 'vitest';

import { buildRows, collectWithRetry, formatPretty, readLocalBrokerMaps } from './fleet-agent.js';
import type { FleetInventoryAgent, ListAgent } from '@agent-relay/harness-driver';
import type { RelayNode } from '@agent-relay/sdk';

const NOW = new Date('2026-08-17T09:00:00Z');

function node(overrides: Partial<RelayNode>): RelayNode {
  return {
    name: 'unnamed',
    status: 'online',
    live: true,
    capabilities: [],
    ...overrides,
  } as RelayNode;
}

function liveAgent(name: string, overrides: Partial<ListAgent> = {}): ListAgent {
  return {
    name,
    runtime: 'pty',
    channels: [],
    ...overrides,
  } as ListAgent;
}

function inventoryAgent(name: string): FleetInventoryAgent {
  return { agent_id: `ag_${name}`, name };
}

describe('buildRows — the diagnostic column exists', () => {
  it('flags a live+inventory+roster row when all three surfaces agree', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [
              liveAgent('worker-a', {
                cli: 'claude',
                current_state: 'working',
                last_activity_at: NOW.toISOString(),
              }),
            ],
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [{ name: 'worker-a' }],
      },
      NOW
    );

    expect(out.perNode).toHaveLength(1);
    expect(out.perNode[0]).toMatchObject({
      node: 'sf-mini',
      name: 'worker-a',
      presence: 'live+inventory+roster',
    });
    expect(out.unplacedRoster).toEqual([]);
  });

  it('must-fire: a live-only worker (in PTY map, missing from inventory) shows the #1539 signature', () => {
    // This is the load-bearing test for the whole command: an agent alive on
    // the broker but absent from the fleet_inventory snapshot the engine
    // sees. Delete the `inventory only` branch in classifyPresence and this
    // row's presence stops being distinguishable from the agreement case.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('lost-agent', { cli: 'claude' })],
            inventoryAgents: [],
          },
        ],
        roster: [],
      },
      NOW
    );

    const row = out.perNode.find((r) => r.name === 'lost-agent');
    expect(row).toBeDefined();
    expect(row?.presence).toBe('live only');

    const rendered = formatPretty(out);
    expect(rendered).toContain('lost-agent');
    expect(rendered).toContain('live only');
    // The legend must fire when a live-only row is present — an operator
    // reading only the table without context would otherwise miss the shape.
    expect(rendered).toContain('relay#1539 shape');
  });

  it('must-fire: an inventory-only worker (published but no PTY) is visibly different', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [],
            inventoryAgents: [inventoryAgent('ghost-agent')],
          },
        ],
        roster: [],
      },
      NOW
    );

    const row = out.perNode.find((r) => r.name === 'ghost-agent');
    expect(row?.presence).toBe('inventory only');
    // State column must not lie about liveness for inventory-only rows.
    expect(row?.state).not.toContain('idle');
    expect(row?.state).not.toContain('working');
  });

  it('must-not-fire: when the two maps agree, no divergence row is emitted', () => {
    // Guard against the opposite failure: a false-positive divergence.
    // Break the equality check (e.g. hard-code presence to 'live only') and
    // this test flips red — proving the guard has teeth.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('worker-a', { cli: 'claude' })],
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );

    for (const row of out.perNode) {
      expect(row.presence).not.toBe('live only');
      expect(row.presence).not.toBe('inventory only');
    }
  });

  it('never drops a node — a failure surfaces as an error row, not omission', () => {
    // A node with contribution.error must still appear in the table. The
    // whole issue #1553 is founded on this invariant: an omitted node is
    // indistinguishable from a node with zero agents, which is the exact
    // ambiguity the command exists to remove.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'chief-broker' }),
            isLocal: false,
            error: "Node 'chief-broker' is not reachable",
            retried: true,
          },
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('worker-a')],
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );

    const errorRow = out.perNode.find((r) => r.node === 'chief-broker');
    expect(errorRow).toBeDefined();
    expect(errorRow?.state).toContain('ERROR');
    expect(errorRow?.note).toBe('retried');
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ node: 'chief-broker' });

    // And the rendered table must include the node name in the error footer.
    const rendered = formatPretty(out);
    expect(rendered).toContain('chief-broker');
    expect(rendered).toContain('not reachable');
  });

  it('remote nodes render as count-only rows and never as fake per-agent rows', () => {
    // The exact defect #1553 exists to prevent. `chief-broker` reporting
    // `activeAgents=0` while agents are alive on it is a known engine gap;
    // this test proves we do not silently accept the count as reality.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'finn-mini', activeAgents: 33 }),
            isLocal: false,
          },
          {
            node: node({ name: 'chief-broker', activeAgents: 0 }),
            isLocal: false,
          },
        ],
        roster: [],
      },
      NOW
    );

    const finn = out.perNode.find((r) => r.node === 'finn-mini');
    expect(finn?.presence).toBe('count only');
    expect(finn?.name).toContain('33 agents');
    expect(finn?.name).toContain('names unavailable');

    const chief = out.perNode.find((r) => r.node === 'chief-broker');
    expect(chief?.presence).toBe('count only');
    expect(chief?.name).toContain('0 agents');
    // Zero agents from the workspace API is not evidence the node is empty.
    // The label must still say "names unavailable" so a reader cannot mistake
    // this for a confirmed empty node.
    expect(chief?.name).toContain('names unavailable');
  });

  it('roster-only identities land in a distinct unplaced section', () => {
    // The `-cli` messaging identity from the #1553 census: a live posting
    // agent in the roster that shows up in no node worker map. It must not
    // be attributed to any per-node row, only listed as roster-only.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('worker-a', { cli: 'claude' })],
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [{ name: 'worker-a' }, { name: 'chief-broker-grok-capability-0817-cli' }],
      },
      NOW
    );

    const perNodeNames = out.perNode.map((r) => r.name);
    expect(perNodeNames).not.toContain('chief-broker-grok-capability-0817-cli');
    expect(out.unplacedRoster).toHaveLength(1);
    expect(out.unplacedRoster[0]).toMatchObject({
      node: '?',
      name: 'chief-broker-grok-capability-0817-cli',
      presence: 'roster only',
    });
  });

  it('sorts rows deterministically by (node, name) so scripted diffs are stable', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('b-worker'), liveAgent('a-worker')],
            inventoryAgents: [inventoryAgent('a-worker'), inventoryAgent('b-worker')],
          },
          {
            node: node({ name: 'finn-mini', activeAgents: 2 }),
            isLocal: false,
          },
        ],
        roster: [],
      },
      NOW
    );

    const order = out.perNode.map((r) => `${r.node}:${r.name}`);
    expect(order).toEqual([
      'finn-mini:<2 agents — names unavailable>',
      'sf-mini:a-worker',
      'sf-mini:b-worker',
    ]);
  });
});

describe('buildRows — partial local-broker reads never discard the surviving map', () => {
  it("must-not-fire: inventory failure alone does NOT mislabel live agents as the '#1539 shape'", () => {
    // Reviewer regression: when only `/api/fleet-inventory` fails (missing
    // route on an older broker, or `success:false` from a closed runtime
    // channel), the CLI must not label live agents as `live only` — the
    // relay#1539 divergence signature — because the divergence is
    // unverified. Reintroduce the pre-fix Promise.all behaviour (which
    // treated the inventory failure as an empty inventory) and this test
    // flips red.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('worker-a', { cli: 'claude' })],
            // inventoryAgents intentionally unset — the failure branch.
            inventoryError: 'HTTP 404: /api/fleet-inventory not found',
          },
        ],
        roster: [],
      },
      NOW
    );

    const row = out.perNode.find((r) => r.name === 'worker-a');
    expect(row).toBeDefined();
    // Must be tagged with the uncertainty marker, NOT with the false #1539
    // divergence signature.
    expect(row?.presence).toBe('live only (inventory?)');
    expect(row?.presence).not.toBe('live only');

    // And the live name must still appear — this whole test class exists
    // because the pre-fix code dropped it.
    expect(row?.state).toContain('unknown');
    // ^ current_state was undefined; renderState returns '· unknown'.

    // Legend explains the `(?)` marker.
    const rendered = formatPretty(out);
    expect(rendered).toContain('worker-a');
    expect(rendered).toContain('(inventory?)');
    expect(rendered).toContain('treat that surface as unknown, not empty');
  });

  it("must-not-fire: live failure alone does NOT mislabel inventory entries as the '#1539 shape'", () => {
    // Symmetric guard: an operator reading a row where only `/api/spawned`
    // failed must not be told the agent is `inventory only` (which would
    // read as "published but no PTY"). The uncertainty marker prevents that.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveError: 'ECONNREFUSED (broker gone away)',
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );

    const row = out.perNode.find((r) => r.name === 'worker-a');
    expect(row?.presence).toBe('inventory only (live?)');
    expect(row?.presence).not.toBe('inventory only');
  });

  it('must-fire: both halves failing still produces an ERROR row that names the node', () => {
    // The one case where the local node degrades to an ERROR row. Under the
    // pre-fix code, ANY half failing caused this — that was the bug. This
    // test says: when both halves are genuinely gone, the error remains.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveError: 'ECONNREFUSED',
            inventoryError: 'ECONNREFUSED',
          },
        ],
        roster: [],
      },
      NOW
    );

    const row = out.perNode.find((r) => r.node === 'sf-mini');
    expect(row?.state).toContain('ERROR');
    expect(row?.state).toContain('ECONNREFUSED');
    expect(out.errors).toHaveLength(1);
  });

  it('must-not-fire: partial-empty is labelled as unknown, not as a confirmed empty node', () => {
    // With one half known-empty and the other unknown, the row must NOT
    // read "<0 agents on this node>" as if the node were confirmed empty.
    // A partial observation of empty is not a confirmed empty result.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [],
            inventoryError: 'HTTP 404: /api/fleet-inventory not found',
          },
        ],
        roster: [],
      },
      NOW
    );

    const row = out.perNode.find((r) => r.node === 'sf-mini');
    expect(row?.presence).toBe('empty (inventory?)');
    // "total unknown" is the operator-facing warning that makes this row
    // impossible to misread as a clean zero.
    expect(row?.name).toContain('total unknown');
    expect(row?.name).not.toContain('<0 agents on this node>');
  });
});

describe('buildRows — a synthetic local contribution is never dropped', () => {
  // The fleet.ts fan-out is responsible for unshifting a synthetic local
  // contribution when the local node is filtered out of `visibleNodes`. Here
  // we lock in the invariant at the join layer: a caller that hands a local
  // contribution to buildRows always sees it rendered, whatever the node
  // record looks like.
  it('renders a local-contribution row even when the node has no capabilities and status is unknown', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: {
              // Simulating a synthesized RelayNode built when nodes.list()
              // filtered the local machine out (e.g. handlersLive === false).
              name: '(local broker)',
              status: 'unknown',
              capabilities: [],
            } as RelayNode,
            isLocal: true,
            liveAgents: [liveAgent('worker-a', { cli: 'claude' })],
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );

    expect(out.perNode.find((r) => r.name === 'worker-a')).toBeDefined();
    // NODE column is not empty; the fake name propagates so an operator can
    // still search their logs. It must NOT read `?` (which is reserved for
    // roster-only unplaced rows).
    expect(out.perNode[0]?.node).toBe('(local broker)');
  });
});

describe('readLocalBrokerMaps — Promise.allSettled semantics', () => {
  it('preserves the live map when only inventory throws', async () => {
    // Reviewer flag translated into a unit test at the harness-driver join
    // point. The old Promise.all-based helper would let a listFleetInventory
    // rejection cancel the resolved listAgents result; allSettled means
    // both halves are preserved independently.
    const stub = {
      listAgents: async () => [liveAgent('worker-a', { cli: 'claude' })],
      listFleetInventory: async () => {
        throw new Error('HTTP 404: /api/fleet-inventory not found');
      },
    };
    const result = await readLocalBrokerMaps(stub as unknown as Parameters<typeof readLocalBrokerMaps>[0]);
    expect(result.liveAgents).toHaveLength(1);
    expect(result.liveError).toBeUndefined();
    expect(result.inventoryAgents).toBeUndefined();
    expect(result.inventoryError).toContain('/api/fleet-inventory not found');
  });

  it('preserves the inventory map when only listAgents throws', async () => {
    const stub = {
      listAgents: async () => {
        throw new Error('EHOSTUNREACH');
      },
      listFleetInventory: async () => ({
        nodeName: 'sf-mini',
        agents: [inventoryAgent('worker-a')],
      }),
    };
    const result = await readLocalBrokerMaps(stub as unknown as Parameters<typeof readLocalBrokerMaps>[0]);
    expect(result.inventoryAgents).toHaveLength(1);
    expect(result.inventoryError).toBeUndefined();
    expect(result.liveAgents).toBeUndefined();
    expect(result.liveError).toContain('EHOSTUNREACH');
  });
});

describe('formatPretty — legend behaviour', () => {
  it('renders the idle legend when any row is idle, and does not otherwise', () => {
    const withIdle = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('worker-a', { current_state: 'idle', cli: 'claude' })],
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );
    const withoutIdle = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini' }),
            isLocal: true,
            liveAgents: [liveAgent('worker-a', { current_state: 'working', cli: 'claude' })],
            inventoryAgents: [inventoryAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );

    expect(formatPretty(withIdle)).toContain('does NOT prove');
    // Must-not-fire: the legend cannot appear when no row is idle.
    expect(formatPretty(withoutIdle)).not.toContain('does NOT prove');
  });
});

describe('collectWithRetry — a transient failure retries once', () => {
  it('reports retried=true on second-attempt success', async () => {
    let calls = 0;
    const result = await collectWithRetry(
      'test',
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return 'ok';
      },
      { retries: 1, baseDelayMs: 0, sleep: async () => undefined }
    );
    expect(result).toEqual({ ok: true, value: 'ok', retried: true });
    expect(calls).toBe(2);
  });

  it('surfaces the failure with retried=true when both attempts fail', async () => {
    const result = await collectWithRetry(
      'test',
      async () => {
        throw new Error('permanent');
      },
      { retries: 1, baseDelayMs: 0, sleep: async () => undefined }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('test: permanent');
      expect(result.retried).toBe(true);
    }
  });
});
