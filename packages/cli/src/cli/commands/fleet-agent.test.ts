import { describe, expect, it } from 'vitest';

import {
  buildRows,
  formatPretty,
  LIVE_AGENT_CAPABILITY_NAME,
  readRemoteLiveAgents,
  type RemoteLiveAgent,
} from './fleet-agent.js';
import type { RelayNode } from '@agent-relay/sdk';

const NOW = new Date('2026-08-17T09:00:00Z');

function node(overrides: Partial<RelayNode>): RelayNode {
  return {
    name: 'unnamed',
    status: 'online',
    live: true,
    handlersLive: true,
    capabilities: [],
    ...overrides,
  } as RelayNode;
}

function remoteAgent(name: string): RemoteLiveAgent {
  return { name };
}

describe('readRemoteLiveAgents', () => {
  it('decodes the versioned heartbeat marker and exact WorkerNames', () => {
    const result = readRemoteLiveAgents(
      node({
        name: 'sf-mini',
        capabilities: [
          {
            name: LIVE_AGENT_CAPABILITY_NAME,
            kind: 'capacity',
            metadata: { names: ['worker-z', 'å-worker'] },
          },
        ],
      })
    );

    expect(result).toEqual({
      supported: true,
      complete: true,
      agents: [{ name: 'å-worker' }, { name: 'worker-z' }],
    });
  });

  it('treats an absent marker as an unsupported old broker', () => {
    expect(readRemoteLiveAgents(node({ name: 'sf-mini', capabilities: [] }))).toEqual({
      supported: false,
      complete: false,
      agents: [],
    });
  });

  it('reports malformed names instead of decoding them authoritatively', () => {
    expect(
      readRemoteLiveAgents(
        node({
          name: 'sf-mini',
          capabilities: [
            {
              name: LIVE_AGENT_CAPABILITY_NAME,
              kind: 'capacity',
              metadata: { names: [null] },
            },
          ],
        })
      )
    ).toMatchObject({
      supported: true,
      complete: false,
      agents: [],
      warning: expect.stringContaining('1 malformed'),
    });
  });

  it('keeps a roster with only duplicate names complete', () => {
    expect(
      readRemoteLiveAgents(
        node({
          name: 'sf-mini',
          capabilities: [
            { name: LIVE_AGENT_CAPABILITY_NAME, kind: 'capacity', metadata: { names: ['w', 'w'] } },
          ],
        })
      )
    ).toMatchObject({ supported: true, complete: true, agents: [{ name: 'w' }] });
  });
});

describe('buildRows — the diagnostic column exists', () => {
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
            error: "Node 'chief-broker' is not reachable",
            retried: true,
          },
          {
            node: node({ name: 'sf-mini', activeAgents: 1 }),
            remoteAgents: [remoteAgent('worker-a')],
          },
        ],
        roster: [{ name: 'worker-a' }],
      },
      NOW
    );

    // A heartbeat name that is also in the workspace roster joins it.
    expect(out.perNode.find((r) => r.name === 'worker-a')?.presence).toBe('remote live+roster');
    expect(out.unplacedRoster).toEqual([]);

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

  it('remote nodes render names from their heartbeat-published live WorkerName set', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'finn-mini', activeAgents: 2, lastHeartbeatAt: NOW.toISOString() }),
            remoteAgents: [remoteAgent('worker-b'), remoteAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );

    expect(out.perNode.map((row) => row.name)).toEqual(['worker-a', 'worker-b']);
    expect(out.perNode.every((row) => row.presence === 'remote live')).toBe(true);
    expect(formatPretty(out)).not.toContain('names unavailable');
  });

  it('labels a failed remote inventory query as degraded rather than authoritative count-only output', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'finn-mini', activeAgents: 2 }),
            remoteError: 'remote broker does not support live inventory snapshots',
            retried: true,
          },
        ],
        roster: [],
      },
      NOW
    );

    expect(out.perNode[0]).toMatchObject({
      node: 'finn-mini',
      state: '· remote degraded',
      presence: 'count only (degraded)',
    });
    expect(out.perNode[0]?.name).toContain('names unavailable: live-name heartbeat unavailable');
    expect(formatPretty(out)).toContain('names may be incomplete');
  });

  it('separates an offline control plane from stale remote worker evidence', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'finn-mini', status: 'offline', live: false, activeAgents: 1 }),
            remoteAgents: [remoteAgent('possibly-live')],
          },
        ],
        roster: [],
      },
      NOW
    );
    expect(out.perNode[0]).toMatchObject({
      controlPlane: 'offline',
      workerLiveness: 'unknown',
      presence: 'remote stale (control plane unavailable)',
    });
    expect(formatPretty(out)).toContain('remote stale');
    expect(formatPretty(out)).toContain('worker liveness is unknown');
  });

  it.each([
    ['offline', { status: 'offline', live: false }],
    ['unknown', { status: 'online', live: undefined }],
  ])('keeps a reconciled empty inventory remote-stale when the control plane is %s', (_label, state) => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'chief-broker', ...state, activeAgents: 0 }),
            remoteAgents: [],
          },
        ],
        roster: [],
      },
      NOW
    );
    expect(out.perNode[0]).toMatchObject({
      controlPlane: _label,
      workerLiveness: 'unknown',
      presence: 'remote stale (control plane unavailable)',
    });
    expect(formatPretty(out)).toContain('remote stale');
    expect(formatPretty(out)).not.toContain('names may be incomplete');
  });

  // relay#1563 Low: the backfill loop used to key off the *rendered* node
  // name, which collapses to the literal '(unnamed)' placeholder for any
  // node with an empty name. Two distinct unnamed nodes then looked
  // identical to `Array.find`, so only the first ever got its
  // controlPlane/workerLiveness axes filled in — the second silently kept
  // them omitted (`undefined`), even though buildRows' own contract says
  // every row carries both axes explicitly.
  it('backfills controlPlane/workerLiveness independently for two distinct unnamed nodes', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: '', status: 'offline', live: false }),
            error: 'unreachable-a',
          },
          {
            node: node({ name: '', status: 'online', live: true, handlersLive: true }),
            error: 'unreachable-b',
          },
        ],
        roster: [],
      },
      NOW
    );

    const rowA = out.perNode.find((row) => row.state.includes('unreachable-a'));
    expect(rowA).toMatchObject({ node: '(unnamed)', controlPlane: 'offline', workerLiveness: 'unknown' });

    const rowB = out.perNode.find((row) => row.state.includes('unreachable-b'));
    expect(rowB).toMatchObject({ node: '(unnamed)', controlPlane: 'online', workerLiveness: 'unknown' });
  });

  it('preserves stale remote evidence for two distinct unnamed offline nodes', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: '', status: 'offline', live: false, activeAgents: 1 }),
            remoteAgents: [remoteAgent('stale-worker-a')],
          },
          {
            node: node({ name: '', status: 'offline', live: false, activeAgents: 1 }),
            remoteAgents: [remoteAgent('stale-worker-b')],
          },
        ],
        roster: [],
      },
      NOW
    );

    expect(out.perNode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'stale-worker-a',
          node: '(unnamed)',
          controlPlane: 'offline',
          workerLiveness: 'unknown',
          presence: 'remote stale (control plane unavailable)',
        }),
        expect.objectContaining({
          name: 'stale-worker-b',
          node: '(unnamed)',
          controlPlane: 'offline',
          workerLiveness: 'unknown',
          presence: 'remote stale (control plane unavailable)',
        }),
      ])
    );
  });

  it.each([
    ['offline', { status: 'offline', live: false }],
    ['unknown', { status: 'unknown', live: undefined }],
  ])('keeps %s control-plane heartbeat mismatches remote-stale and unknown', (_label, controlPlane) => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'finn-mini', ...controlPlane, activeAgents: 2 }),
            remoteAgents: [remoteAgent('stale-worker')],
          },
        ],
        roster: [],
      },
      NOW
    );

    const mismatch = out.perNode.find((row) => row.name.startsWith('<'));
    expect(mismatch).toMatchObject({
      state: '· remote stale',
      presence: 'remote stale (control plane unavailable)',
      workerLiveness: 'unknown',
    });
    expect(mismatch?.note).toContain('stale: heartbeat reports 2, broker returned 1');
    expect(mismatch?.note).not.toContain('degraded');
  });

  it('renders independent control-plane and worker columns in pretty output', () => {
    const rendered = formatPretty(
      buildRows(
        {
          contributions: [
            {
              node: node({ name: 'finn-mini', status: 'offline', live: false, activeAgents: 1 }),
              remoteAgents: [remoteAgent('worker-live')],
            },
          ],
          roster: [],
        },
        NOW
      )
    );
    expect(rendered).toContain('CONTROL PLANE');
    expect(rendered).toContain('WORKERS');
    expect(rendered).toContain('Offline or degraded control plane does not prove workers are dead');
  });

  it('keeps known remote names but exposes a heartbeat/inventory count mismatch', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'finn-mini', activeAgents: 2, lastHeartbeatAt: NOW.toISOString() }),
            remoteAgents: [remoteAgent('worker-a')],
          },
        ],
        roster: [],
      },
      NOW
    );

    expect(out.perNode.map((row) => row.name)).toEqual([
      '<1 additional agent — names unavailable: broker/heartbeat mismatch>',
      'worker-a',
    ]);
    expect(out.perNode.find((row) => row.name === 'worker-a')?.note).toContain(
      'heartbeat reports 2, broker returned 1'
    );
    expect(out.perNode.find((row) => row.name.startsWith('<'))?.state).toBe('· remote degraded');
  });

  it('labels names as degraded when the control-plane count updates before the next broker heartbeat', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini', activeAgents: 0, lastHeartbeatAt: NOW.toISOString() }),
            remoteAgents: [remoteAgent('worker-releasing')],
          },
        ],
        roster: [],
      },
      NOW
    );

    expect(out.perNode).toHaveLength(1);
    expect(out.perNode[0]).toMatchObject({
      name: 'worker-releasing',
      presence: 'remote live',
      note: 'degraded: heartbeat reports 0, broker returned 1',
    });
    expect(formatPretty(out)).toContain('degraded: heartbeat reports 0, broker returned 1');
  });

  it('roster-only identities land in a distinct unplaced section', () => {
    // The `-cli` messaging identity from the #1553 census: a live posting
    // agent in the roster that shows up in no node worker map. It must not
    // be attributed to any per-node row, only listed as roster-only.
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini', activeAgents: 1 }),
            remoteAgents: [remoteAgent('worker-a')],
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
      controlPlane: 'unknown',
      workerLiveness: 'unknown',
    });
  });

  it('sorts rows deterministically by (node, name) so scripted diffs are stable', () => {
    const out = buildRows(
      {
        contributions: [
          {
            node: node({ name: 'sf-mini', activeAgents: 2 }),
            remoteAgents: [remoteAgent('b-worker'), remoteAgent('a-worker')],
          },
          {
            node: node({ name: 'finn-mini', activeAgents: 2 }),
            remoteAgents: [remoteAgent('a-remote'), remoteAgent('b-remote')],
          },
        ],
        roster: [],
      },
      NOW
    );

    const order = out.perNode.map((r) => `${r.node}:${r.name}`);
    expect(order).toEqual([
      'finn-mini:a-remote',
      'finn-mini:b-remote',
      'sf-mini:a-worker',
      'sf-mini:b-worker',
    ]);
  });
});
