import { describe, expect, it } from 'vitest';
import {
  alternativesFor,
  assessMemory,
  DEFAULT_MEMORY_POLICY,
  GIB,
  memoryLowMessage,
  memoryRefusal,
  MemoryPolicyError,
  parseBytes,
  parseMemoryPolicy,
  rankCandidates,
  type PlacementCandidate,
} from './index.js';
import { GOLDEN_FIXTURES, type GoldenFixture } from './fixtures.js';

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** The reference adapter: what each control plane's own adapter must agree with. */
function candidateFrom(node: Raw, fixture: GoldenFixture): PlacementCandidate {
  const capabilities = (node.capabilities as Raw[]).map(record).filter((c): c is Raw => !!c);
  const configured = capabilities
    .map((c) => record(record(c.metadata)?.configured))
    .filter((c): c is Raw => !!c);
  const lives = capabilities.map((c) => record(record(c.metadata)?.live)).filter((c): c is Raw => !!c);
  const newest = [...lives].sort((a, b) =>
    String(b.observed_at ?? '').localeCompare(String(a.observed_at ?? ''))
  )[0];
  const resources = record(newest?.resources);
  const owner = fixture.owners[String(node.id)];
  const kind = configured.some((c) => c.node_kind === 'desktop') ? 'desktop' : 'broker';
  return {
    id: String(node.id),
    kind,
    allowed: owner ? owner.userId === fixture.userId : kind === 'broker',
    isYours: owner?.userId === fixture.userId,
    harnesses: capabilities.map((c) => String(c.name).slice('spawn:'.length)),
    repositories: [...new Set(configured.flatMap((c) => (c.repositories as string[]) ?? []))],
    maxAgents: node.max_agents as number,
    activeAgents: node.active_agents as number,
    reservedAgents: node.reserved_agents as number,
    utilization: null,
    load1m: num(resources?.load_1m),
    cpus: num(resources?.cpus),
    memory: {
      availableBytes: num(resources?.memory_available_bytes),
      totalBytes: num(resources?.memory_total_bytes),
      observedAt: typeof newest?.observed_at === 'string' ? newest.observed_at : null,
    },
    nodeFloorBytes: configured.map((c) => num(c.memory_floor_bytes)).find((v) => v !== null) ?? null,
    pendingLaunches: fixture.pendingLaunches?.[String(node.id)] ?? 0,
  };
}

describe('golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(fixture.name, () => {
      const policy = parseMemoryPolicy(fixture.settings);
      const ranked = rankCandidates(
        fixture.nodes.map((node) => candidateFrom(node, fixture)),
        { harness: fixture.harness, policy, now: new Date(fixture.now) }
      );
      expect(ranked.map((entry) => entry.candidate.id)).toEqual(fixture.expected.order);
      for (const entry of ranked) {
        const { tier, admissible, reason } = entry.memory;
        expect({ tier, admissible, reason }, entry.candidate.id).toEqual(
          fixture.expected.memory[entry.candidate.id]
        );
      }
      const refusal = fixture.expected.refusal;
      if (refusal) {
        const target = ranked.find((entry) => entry.candidate.id === refusal.target)!;
        expect(memoryRefusal(target, policy) !== null).toBe(refusal.memoryLow);
        expect(
          alternativesFor(ranked, fixture.harness ?? 'claude', {
            id: refusal.target,
            repositories: target.candidate.repositories,
          }).map((entry) => entry.candidate.id)
        ).toEqual(refusal.alternatives);
      }
    });
  }
});

const base: PlacementCandidate = {
  id: 'n',
  kind: 'desktop',
  allowed: true,
  isYours: true,
  harnesses: ['claude'],
  repositories: [],
  maxAgents: 0,
  activeAgents: 0,
  reservedAgents: 0,
  utilization: null,
  load1m: 1,
  cpus: 4,
  memory: { availableBytes: 2.5 * GIB, totalBytes: 16 * GIB, observedAt: '2026-11-19T12:00:00.000Z' },
};
const now = new Date('2026-11-19T12:00:05.000Z');

describe('assessMemory', () => {
  it('reports the worked example from the spec', () => {
    const memory = assessMemory(base, 'claude', DEFAULT_MEMORY_POLICY, now);
    expect(memory).toMatchObject({
      tier: 'low',
      reason: 'available',
      floor_bytes: 2 * GIB,
      need_bytes: 1.5 * GIB,
      agents_fit: 0,
      memory_cap: 14,
      age_seconds: 5,
      fresh: true,
    });
    expect(memoryLowMessage('studio', 'claude', memory)).toBe(
      'Node "studio" has 2.5 GB free; launching claude needs 1.5 GB on top of the 2 GB it keeps free.'
    );
  });

  it('gives a harness named like an Object member the default budget', () => {
    for (const harness of ['constructor', 'toString', '__proto__']) {
      expect(assessMemory(base, harness, DEFAULT_MEMORY_POLICY, now)).toMatchObject({
        need_bytes: 1.5 * GIB,
        tier: 'low',
      });
    }
  });

  it('fails open on unparseable or absent samples', () => {
    for (const memory of [
      null,
      { ...base.memory!, observedAt: 'yesterday' },
      { ...base.memory!, availableBytes: null },
    ]) {
      expect(assessMemory({ ...base, memory }, 'claude', DEFAULT_MEMORY_POLICY, now)).toMatchObject({
        tier: 'unknown',
        admissible: true,
      });
    }
  });

  it('limits agents_fit by free slots and the density cap', () => {
    const roomy = { ...base, memory: { ...base.memory!, availableBytes: 14 * GIB } };
    expect(assessMemory(roomy, 'codex', DEFAULT_MEMORY_POLICY, now).agents_fit).toBe(12);
    expect(
      assessMemory({ ...roomy, maxAgents: 5, activeAgents: 2 }, 'codex', DEFAULT_MEMORY_POLICY, now)
        .agents_fit
    ).toBe(3);
    expect(assessMemory({ ...roomy, activeAgents: 10 }, 'codex', DEFAULT_MEMORY_POLICY, now).agents_fit).toBe(
      4
    );
  });
});

describe('rankCandidates', () => {
  it('does not admit a node that lacks the named harness', () => {
    const roomy = { ...base, memory: { ...base.memory!, availableBytes: 40 * GIB, totalBytes: 64 * GIB } };
    const policy = parseMemoryPolicy({ mode: 'rank' });
    const ranked = rankCandidates(
      [
        { ...roomy, id: 'codex-only', harnesses: ['codex'] },
        { ...base, id: 'claude-low' },
        { ...roomy, id: 'claude-ok' },
      ],
      { harness: 'claude', policy, now }
    );
    expect(ranked.map((entry) => [entry.candidate.id, entry.admissible])).toEqual([
      ['claude-ok', true],
      ['codex-only', false],
      ['claude-low', false],
    ]);
  });
});

describe('parseMemoryPolicy', () => {
  it('parses every setting', () => {
    const policy = parseMemoryPolicy({
      mode: 'ENFORCE',
      floor: 'desktop=3GiB/12.5%',
      harnessMemory: 'claude=2GiB,muse=512MiB',
      agentMemory: '768MiB',
      densityCapsConfigured: 'true',
      freshSeconds: '60',
    });
    expect(policy.mode).toBe('enforce');
    expect(policy.floor.desktop).toEqual({ bytes: 3 * GIB, fraction: 0.125 });
    expect(policy.floor.broker).toEqual(DEFAULT_MEMORY_POLICY.floor.broker);
    expect(policy.harnessNeedBytes).toMatchObject({ claude: 2 * GIB, muse: 512 * 1024 ** 2, codex: GIB });
    expect(policy.agentSteadyBytes).toBe(768 * 1024 ** 2);
    expect(policy.densityCapsConfigured).toBe(true);
    expect(policy.freshSeconds).toBe(60);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('keeps defaults for empty settings', () => {
    expect(parseMemoryPolicy({ mode: '', floor: ' ' })).toEqual(DEFAULT_MEMORY_POLICY);
  });

  it.each([
    [{ mode: 'strict' }, 'mode'],
    [{ floor: 'laptop=1GiB/5%' }, 'floor'],
    [{ floor: 'desktop=1GiB' }, 'floor'],
    [{ floor: 'desktop=1GiB/100%' }, 'floor'],
    [{ harnessMemory: 'Claude=1GiB' }, 'harnessMemory'],
    [{ harnessMemory: 'claude=0' }, 'harnessMemory'],
    [{ harnessMemory: 'claude' }, 'harnessMemory'],
    [{ agentMemory: 'lots' }, 'agentMemory'],
    [{ densityCapsConfigured: 'yes' }, 'densityCapsConfigured'],
    [{ freshSeconds: '0' }, 'freshSeconds'],
    [{ freshSeconds: '4.5' }, 'freshSeconds'],
  ])('refuses %j', (settings, setting) => {
    expect(() => parseMemoryPolicy(settings)).toThrow(MemoryPolicyError);
    try {
      parseMemoryPolicy(settings);
    } catch (error) {
      expect((error as MemoryPolicyError).setting).toBe(setting);
    }
  });

  it('parses sizes', () => {
    expect(parseBytes('1.5GiB')).toBe(1.5 * GIB);
    expect(parseBytes('2GB')).toBe(2e9);
    expect(parseBytes('4096')).toBe(4096);
    expect(parseBytes('1.5')).toBeNull();
    expect(parseBytes('-1GiB')).toBeNull();
    expect(parseBytes('1TiB')).toBeNull();
    expect(parseBytes(' 1.5 GiB ')).toBe(1.5 * GIB);
    // Long whitespace runs are trimmed or refused, never backtracked over (CodeQL js/polynomial-redos).
    const started = Date.now();
    expect(parseBytes('0' + '\t'.repeat(50_000) + 'x')).toBeNull();
    expect(parseBytes('0' + '\t'.repeat(50_000))).toBe(0);
    expect(Date.now() - started).toBeLessThan(100);
    expect(parseBytes('1 constructor')).toBeNull();
  });
});
