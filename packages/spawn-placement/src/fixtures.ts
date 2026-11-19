/**
 * Golden fixtures: raw Relaycast `GET /v1/nodes` records in, expected
 * placement out. Every control plane runs these through its own adapter
 * (raw node → `PlacementCandidate`, with its own permission rules) and
 * asserts the expected result, so the policy cannot drift between them.
 *
 * Nodes here are claimed by `userId` (yours) or are unclaimed brokers
 * (shared), which every control plane allows. Fixtures tagged `hosted` use
 * Cloud-sandbox nodes; a control plane without that kind skips them.
 */

import type { MemoryLowReason, MemoryTier } from './memory.js';
import { GIB, type MemoryPolicySettings } from './policy.js';

export interface GoldenFixture {
  name: string;
  tags: string[];
  /** ISO-8601; the `now` to assess with. */
  now: string;
  settings: MemoryPolicySettings;
  /** The harness the caller intends to launch; null means none named. */
  harness: string | null;
  userId: string;
  owners: Record<string, { userId: string; name: string | null }>;
  /** Raw Relaycast node records, in roster order. */
  nodes: Array<Record<string, unknown>>;
  /** Launches this control plane has in flight per node id, after each node's sample. */
  pendingLaunches?: Record<string, number>;
  expected: {
    /** Node ids, best first. */
    order: string[];
    memory: Record<string, { tier: MemoryTier; admissible: boolean; reason: MemoryLowReason | null }>;
    /** `spawn_memory_low` for this target under the fixture's mode, and the alternatives it would carry. */
    refusal?: { target: string; memoryLow: boolean; alternatives: string[] };
  };
}

const NOW = '2026-11-19T12:00:00.000Z';
const ago = (seconds: number) => new Date(Date.parse(NOW) - seconds * 1000).toISOString();
const ME = 'user-me';

interface NodeSpec {
  id: string;
  kind: 'desktop' | 'broker';
  harnesses?: string[];
  maxAgents?: number;
  active?: number;
  reserved?: number;
  load1m?: number | null;
  cpus?: number;
  totalGiB?: number | null;
  availableGiB?: number | null;
  observedAt?: string | null;
  repositories?: string[];
  memoryFloorBytes?: number;
  tags?: string[];
}

/** A node record as Relaycast returns it, with relay-node's capability metadata. */
function node(spec: NodeSpec): Record<string, unknown> {
  const resources = {
    cpus: spec.cpus ?? 10,
    load_1m: spec.load1m === undefined ? 2 : spec.load1m,
    memory_total_bytes:
      spec.totalGiB === undefined
        ? 16 * GIB
        : spec.totalGiB === null
          ? null
          : Math.round(spec.totalGiB * GIB),
    memory_available_bytes:
      spec.availableGiB === undefined
        ? 8 * GIB
        : spec.availableGiB === null
          ? null
          : Math.round(spec.availableGiB * GIB),
  };
  const configured: Record<string, unknown> = {
    node_kind: spec.kind,
    machine: spec.id,
    teammates: false,
    max_agents: spec.maxAgents ?? 0,
    repositories: spec.repositories ?? [],
    ...(spec.memoryFloorBytes !== undefined ? { memory_floor_bytes: spec.memoryFloorBytes } : {}),
  };
  const live: Record<string, unknown> = {
    ...(spec.observedAt === null ? {} : { observed_at: spec.observedAt ?? ago(5) }),
    resources,
  };
  return {
    id: spec.id,
    name: spec.id,
    live: true,
    handlers_live: true,
    active_agents: spec.active ?? 0,
    reserved_agents: spec.reserved ?? 0,
    max_agents: spec.maxAgents ?? 0,
    tags: spec.tags ?? [],
    capabilities: (spec.harnesses ?? ['claude', 'codex']).map((harness) => ({
      name: `spawn:${harness}`,
      metadata: { configured: { harness, ...configured }, live },
    })),
  };
}

const mine = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { userId: ME, name: 'Me' }]));

/** A 16 GiB desktop with 2.5 GiB available, and a 64 GiB desktop with 30 GiB available, same load. */
const SMALL = node({
  id: 'small-desktop',
  kind: 'desktop',
  totalGiB: 16,
  availableGiB: 2.5,
  repositories: ['acme/app'],
});
const LARGE = node({ id: 'large-desktop', kind: 'desktop', totalGiB: 64, availableGiB: 30 });

const FIXTURES: GoldenFixture[] = [
  {
    name: "observe keeps today's order: a low-memory desktop still ties a healthy one",
    tags: [],
    now: NOW,
    settings: { mode: 'observe' },
    harness: 'claude',
    userId: ME,
    owners: mine('small-desktop', 'large-desktop'),
    nodes: [SMALL, LARGE],
    expected: {
      order: ['small-desktop', 'large-desktop'],
      memory: {
        'small-desktop': { tier: 'low', admissible: false, reason: 'available' },
        'large-desktop': { tier: 'ample', admissible: true, reason: null },
      },
      refusal: { target: 'small-desktop', memoryLow: false, alternatives: ['large-desktop'] },
    },
  },
  {
    name: 'rank puts the healthy desktop first and does not refuse',
    tags: [],
    now: NOW,
    settings: { mode: 'rank' },
    harness: 'claude',
    userId: ME,
    owners: mine('small-desktop', 'large-desktop'),
    nodes: [SMALL, LARGE],
    expected: {
      order: ['large-desktop', 'small-desktop'],
      memory: {
        'small-desktop': { tier: 'low', admissible: false, reason: 'available' },
        'large-desktop': { tier: 'ample', admissible: true, reason: null },
      },
      refusal: { target: 'small-desktop', memoryLow: false, alternatives: ['large-desktop'] },
    },
  },
  {
    name: 'enforce refuses the low-memory desktop with the healthy one as the alternative',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'claude',
    userId: ME,
    owners: mine('small-desktop', 'large-desktop'),
    nodes: [SMALL, LARGE],
    expected: {
      order: ['large-desktop', 'small-desktop'],
      memory: {
        'small-desktop': { tier: 'low', admissible: false, reason: 'available' },
        'large-desktop': { tier: 'ample', admissible: true, reason: null },
      },
      refusal: { target: 'small-desktop', memoryLow: true, alternatives: ['large-desktop'] },
    },
  },
  {
    name: 'codex needs less than claude, so the same desktop fits codex',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'codex',
    userId: ME,
    owners: mine('codex-desktop'),
    // floor max(2 GiB, 1.6 GiB) = 2 GiB; 3.2 − 2 − 1 = 0.2 GiB headroom.
    nodes: [node({ id: 'codex-desktop', kind: 'desktop', totalGiB: 16, availableGiB: 3.2 })],
    expected: {
      order: ['codex-desktop'],
      memory: { 'codex-desktop': { tier: 'tight', admissible: true, reason: null } },
      refusal: { target: 'codex-desktop', memoryLow: false, alternatives: [] },
    },
  },
  {
    name: 'freshness: 45 s old and 30 s ahead are fresh; 46 s old, 31 s ahead and missing are unknown',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'claude',
    userId: ME,
    owners: mine('fresh-45', 'ahead-30', 'stale-46', 'ahead-31', 'no-stamp'),
    nodes: [
      node({ id: 'fresh-45', kind: 'desktop', totalGiB: 16, availableGiB: 2.5, observedAt: ago(45) }),
      node({ id: 'ahead-30', kind: 'desktop', totalGiB: 16, availableGiB: 2.5, observedAt: ago(-30) }),
      node({ id: 'stale-46', kind: 'desktop', totalGiB: 16, availableGiB: 2.5, observedAt: ago(46) }),
      node({ id: 'ahead-31', kind: 'desktop', totalGiB: 16, availableGiB: 2.5, observedAt: ago(-31) }),
      node({ id: 'no-stamp', kind: 'desktop', totalGiB: 16, availableGiB: 2.5, observedAt: null }),
    ],
    expected: {
      order: ['stale-46', 'ahead-31', 'no-stamp', 'fresh-45', 'ahead-30'],
      memory: {
        'fresh-45': { tier: 'low', admissible: false, reason: 'available' },
        'ahead-30': { tier: 'low', admissible: false, reason: 'available' },
        'stale-46': { tier: 'unknown', admissible: true, reason: null },
        'ahead-31': { tier: 'unknown', admissible: true, reason: null },
        'no-stamp': { tier: 'unknown', admissible: true, reason: null },
      },
      refusal: { target: 'stale-46', memoryLow: false, alternatives: ['ahead-31', 'no-stamp'] },
    },
  },
  {
    name: 'unknown memory ranks between ok and tight',
    tags: [],
    now: NOW,
    settings: { mode: 'rank' },
    harness: 'claude',
    userId: ME,
    owners: mine('tight', 'unknown', 'ok'),
    nodes: [
      // floor 2 GiB; 4.5 − 2 − 1.5 = 1 GiB headroom: tight.
      node({ id: 'tight', kind: 'desktop', totalGiB: 16, availableGiB: 4.5 }),
      node({ id: 'unknown', kind: 'desktop', totalGiB: null, availableGiB: null }),
      // floor 6.4 GiB; 12 − 6.4 − 1.5 = 4.1 GiB headroom, (12 − 1.5) / 64 = 16%: ok.
      node({ id: 'ok', kind: 'desktop', totalGiB: 64, availableGiB: 12 }),
    ],
    expected: {
      order: ['ok', 'unknown', 'tight'],
      memory: {
        tight: { tier: 'tight', admissible: true, reason: null },
        unknown: { tier: 'unknown', admissible: true, reason: null },
        ok: { tier: 'ok', admissible: true, reason: null },
      },
    },
  },
  {
    name: 'an unlimited node is full at its density cap',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'codex',
    userId: ME,
    owners: mine('dense'),
    // (16 − 2) / 1 = 14 agents; 14 held.
    nodes: [node({ id: 'dense', kind: 'desktop', maxAgents: 0, active: 14, totalGiB: 16, availableGiB: 12 })],
    expected: {
      order: ['dense'],
      memory: { dense: { tier: 'low', admissible: false, reason: 'density' } },
      refusal: { target: 'dense', memoryLow: true, alternatives: [] },
    },
  },
  {
    name: 'a finite maxAgents ignores the density cap unless configured',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'codex',
    userId: ME,
    owners: mine('finite'),
    nodes: [
      node({ id: 'finite', kind: 'desktop', maxAgents: 20, active: 14, totalGiB: 16, availableGiB: 12 }),
    ],
    expected: {
      order: ['finite'],
      // 12 − 2 − 1 = 9 GiB headroom, (12 − 1) / 16 = 69%: ample.
      memory: { finite: { tier: 'ample', admissible: true, reason: null } },
      refusal: { target: 'finite', memoryLow: false, alternatives: [] },
    },
  },
  {
    name: 'with density caps configured, a finite maxAgents is capped by memory too',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce', densityCapsConfigured: 'true' },
    harness: 'codex',
    userId: ME,
    owners: mine('finite'),
    nodes: [
      node({ id: 'finite', kind: 'desktop', maxAgents: 20, active: 14, totalGiB: 16, availableGiB: 12 }),
    ],
    expected: {
      order: ['finite'],
      memory: { finite: { tier: 'low', admissible: false, reason: 'density' } },
      refusal: { target: 'finite', memoryLow: true, alternatives: [] },
    },
  },
  {
    name: 'reserved places and in-flight launches are subtracted from the sample',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'claude',
    userId: ME,
    owners: mine('reserved', 'inflight', 'clear'),
    nodes: [
      // 5 − 2 × 1.5 = 2 GiB projected; 2 − 2 − 1.5 < 0.
      node({ id: 'reserved', kind: 'desktop', reserved: 2, totalGiB: 16, availableGiB: 5 }),
      node({ id: 'inflight', kind: 'desktop', totalGiB: 16, availableGiB: 5 }),
      // 5 − 2 − 1.5 = 1.5 GiB headroom: tight.
      node({ id: 'clear', kind: 'desktop', totalGiB: 16, availableGiB: 5 }),
    ],
    pendingLaunches: { inflight: 2 },
    expected: {
      // both low, both holding two places (reserved or in flight): roster order.
      order: ['clear', 'reserved', 'inflight'],
      memory: {
        reserved: { tier: 'low', admissible: false, reason: 'available' },
        inflight: { tier: 'low', admissible: false, reason: 'available' },
        clear: { tier: 'tight', admissible: true, reason: null },
      },
      refusal: { target: 'inflight', memoryLow: true, alternatives: ['clear'] },
    },
  },
  {
    name: 'a node floor raises the policy floor and cannot lower it',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'codex',
    userId: ME,
    owners: mine('raised', 'lowered'),
    nodes: [
      // floor raised to 4 GiB; 4.5 − 4 − 1 < 0.
      node({ id: 'raised', kind: 'desktop', totalGiB: 16, availableGiB: 4.5, memoryFloorBytes: 4 * GIB }),
      // a 0.5 GiB request is ignored: floor stays 2 GiB; 3 − 2 − 1 = 0: tight.
      node({ id: 'lowered', kind: 'desktop', totalGiB: 16, availableGiB: 3, memoryFloorBytes: 0.5 * GIB }),
    ],
    expected: {
      order: ['lowered', 'raised'],
      memory: {
        raised: { tier: 'low', admissible: false, reason: 'available' },
        lowered: { tier: 'tight', admissible: true, reason: null },
      },
      refusal: { target: 'raised', memoryLow: true, alternatives: ['lowered'] },
    },
  },
  {
    name: 'admissible ranks above yours: a shared broker with memory beats your low desktop',
    tags: [],
    now: NOW,
    settings: { mode: 'rank' },
    harness: 'claude',
    userId: ME,
    owners: mine('my-desktop'),
    nodes: [
      node({ id: 'my-desktop', kind: 'desktop', totalGiB: 16, availableGiB: 2.5 }),
      // broker floor max(1 GiB, 1.6 GiB) = 1.6 GiB; 20 − 1.6 − 1.5 = 16.9 GiB, 58%: ample.
      node({ id: 'shared-broker', kind: 'broker', totalGiB: 32, availableGiB: 20 }),
    ],
    expected: {
      order: ['shared-broker', 'my-desktop'],
      memory: {
        'my-desktop': { tier: 'low', admissible: false, reason: 'available' },
        'shared-broker': { tier: 'ample', admissible: true, reason: null },
      },
    },
  },
  {
    name: 'without memory ranking, your low desktop stays above the shared broker',
    tags: [],
    now: NOW,
    settings: { mode: 'observe' },
    harness: 'claude',
    userId: ME,
    owners: mine('my-desktop'),
    nodes: [
      node({ id: 'my-desktop', kind: 'desktop', totalGiB: 16, availableGiB: 2.5 }),
      node({ id: 'shared-broker', kind: 'broker', totalGiB: 32, availableGiB: 20 }),
    ],
    expected: {
      order: ['my-desktop', 'shared-broker'],
      memory: {
        'my-desktop': { tier: 'low', admissible: false, reason: 'available' },
        'shared-broker': { tier: 'ample', admissible: true, reason: null },
      },
    },
  },
  {
    name: 'within a tier, load still decides',
    tags: [],
    now: NOW,
    settings: { mode: 'rank' },
    harness: 'claude',
    userId: ME,
    owners: mine('busy', 'quiet'),
    nodes: [
      node({ id: 'busy', kind: 'desktop', totalGiB: 64, availableGiB: 40, load1m: 8, cpus: 10 }),
      node({ id: 'quiet', kind: 'desktop', totalGiB: 64, availableGiB: 40, load1m: 1, cpus: 10 }),
    ],
    expected: {
      order: ['quiet', 'busy'],
      memory: {
        busy: { tier: 'ample', admissible: true, reason: null },
        quiet: { tier: 'ample', admissible: true, reason: null },
      },
    },
  },
  {
    name: 'with no harness named, the default budget applies',
    tags: [],
    now: NOW,
    settings: { mode: 'rank' },
    harness: null,
    userId: ME,
    owners: mine('codex-fit'),
    // codex would fit (0.2 GiB headroom) but the 1.5 GiB default does not.
    nodes: [node({ id: 'codex-fit', kind: 'desktop', totalGiB: 16, availableGiB: 3.2 })],
    expected: {
      order: ['codex-fit'],
      memory: { 'codex-fit': { tier: 'low', admissible: false, reason: 'available' } },
    },
  },
  {
    name: 'launches in flight count toward the density cap',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'codex',
    userId: ME,
    owners: mine('nearly-dense'),
    // cap (16 − 2) / 1 = 14; 13 active + 1 in flight = 14 held.
    nodes: [
      node({ id: 'nearly-dense', kind: 'desktop', maxAgents: 0, active: 13, totalGiB: 16, availableGiB: 12 }),
    ],
    pendingLaunches: { 'nearly-dense': 1 },
    expected: {
      order: ['nearly-dense'],
      memory: { 'nearly-dense': { tier: 'low', admissible: false, reason: 'density' } },
      refusal: { target: 'nearly-dense', memoryLow: true, alternatives: [] },
    },
  },
  {
    name: 'alternatives: a node sharing the repository comes first, and at most three are offered',
    tags: [],
    now: NOW,
    settings: { mode: 'enforce' },
    harness: 'claude',
    userId: ME,
    owners: mine('repo-low', 'calm-1', 'calm-2', 'calm-3', 'calm-4', 'repo-busy'),
    nodes: [
      node({ id: 'repo-low', kind: 'desktop', totalGiB: 16, availableGiB: 2.5, repositories: ['acme/app'] }),
      node({ id: 'calm-1', kind: 'desktop', totalGiB: 64, availableGiB: 40, load1m: 1 }),
      node({ id: 'calm-2', kind: 'desktop', totalGiB: 64, availableGiB: 40, load1m: 1 }),
      node({ id: 'calm-3', kind: 'desktop', totalGiB: 64, availableGiB: 40, load1m: 1 }),
      node({ id: 'calm-4', kind: 'desktop', totalGiB: 64, availableGiB: 40, load1m: 1 }),
      node({
        id: 'repo-busy',
        kind: 'desktop',
        totalGiB: 64,
        availableGiB: 40,
        load1m: 8,
        repositories: ['acme/app'],
      }),
    ],
    expected: {
      order: ['calm-1', 'calm-2', 'calm-3', 'calm-4', 'repo-busy', 'repo-low'],
      memory: {
        'repo-low': { tier: 'low', admissible: false, reason: 'available' },
        'calm-1': { tier: 'ample', admissible: true, reason: null },
        'calm-2': { tier: 'ample', admissible: true, reason: null },
        'calm-3': { tier: 'ample', admissible: true, reason: null },
        'calm-4': { tier: 'ample', admissible: true, reason: null },
        'repo-busy': { tier: 'ample', admissible: true, reason: null },
      },
      refusal: { target: 'repo-low', memoryLow: true, alternatives: ['repo-busy', 'calm-1', 'calm-2'] },
    },
  },
];

export const GOLDEN_FIXTURES: readonly GoldenFixture[] = Object.freeze(FIXTURES);
