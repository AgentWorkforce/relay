/**
 * Whether a machine has the memory for one more agent, from what its node
 * reported. Pure: no I/O and no clock (the caller passes `now`).
 */

import { harnessNeed, type MemoryPolicy, type NodeKind } from './policy.js';

/** What a node reported about its memory in one heartbeat (`metadata.live`). */
export interface MemorySample {
  availableBytes: number | null;
  totalBytes: number | null;
  /** ISO-8601 `metadata.live.observed_at`, the node's own clock. */
  observedAt: string | null;
}

/** A launch target, normalized by each control plane's adapter. */
export interface PlacementCandidate {
  id: string;
  kind: NodeKind;
  /** The caller may spawn here (permission rules are each control plane's own). */
  allowed: boolean;
  /** The caller claimed this node. */
  isYours: boolean;
  harnesses: readonly string[];
  repositories: readonly string[];
  /** 0 is Relaycast's unlimited sentinel. */
  maxAgents: number;
  activeAgents: number;
  reservedAgents: number;
  /** Relaycast's slot utilization, 0–1. */
  utilization: number | null;
  load1m: number | null;
  cpus: number | null;
  memory: MemorySample | null;
  /** A floor the node itself asks for (`metadata.configured.memory_floor_bytes`); it can only raise the policy floor. */
  nodeFloorBytes?: number | null;
  /** This control plane's own launches to the node that the sample cannot reflect yet. */
  pendingLaunches?: number;
}

export type MemoryTier = 'ample' | 'ok' | 'tight' | 'low' | 'unknown';
export type MemoryLowReason = 'available' | 'density';

/** Wire shape (snake_case): returned to MCP clients as `memory`. */
export interface MemoryAssessment {
  tier: MemoryTier;
  /** False only for `low`. */
  admissible: boolean;
  reason: MemoryLowReason | null;
  available_bytes: number | null;
  projected_available_bytes: number | null;
  total_bytes: number | null;
  available_fraction: number | null;
  floor_bytes: number | null;
  need_bytes: number;
  /** More launches of this harness that fit now; null when unknown. */
  agents_fit: number | null;
  memory_cap: number | null;
  held: number;
  observed_at: string | null;
  age_seconds: number | null;
  fresh: boolean;
}

function count(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function bytes(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Free launch slots by Relaycast's count; null means unlimited. */
export function availableSlots(
  candidate: Pick<PlacementCandidate, 'maxAgents' | 'activeAgents' | 'reservedAgents'>
): number | null {
  return candidate.maxAgents === 0
    ? null
    : Math.max(0, candidate.maxAgents - count(candidate.activeAgents) - count(candidate.reservedAgents));
}

/** Policy floor for this node, raised (never lowered) by the node's own floor. */
export function floorBytes(
  policy: MemoryPolicy,
  kind: NodeKind,
  totalBytes: number | null,
  nodeFloorBytes?: number | null
): number {
  const floor = policy.floor[kind];
  const policyFloor = Math.max(
    floor.bytes,
    totalBytes === null ? 0 : Math.floor(floor.fraction * totalBytes)
  );
  const nodeFloor = bytes(nodeFloorBytes);
  return nodeFloor !== null && nodeFloor > policyFloor ? nodeFloor : policyFloor;
}

/**
 * Whether one more launch of `harness` fits on this candidate's machine.
 *
 * @param candidate The target, normalized by the control plane's adapter.
 * @param harness The harness to launch; null or unknown uses the `*` budget.
 * @param policy The memory policy (see `parseMemoryPolicy`).
 * @param now The control plane's clock, for sample freshness.
 * @returns The tier, admissibility and the figures behind them. Unknown or
 *   stale memory is always admissible (fail open).
 */
export function assessMemory(
  candidate: PlacementCandidate,
  harness: string | null | undefined,
  policy: MemoryPolicy,
  now: Date
): MemoryAssessment {
  const need = harnessNeed(policy, harness);
  // Launches still starting hold a place too, even before Relaycast counts them.
  const held =
    count(candidate.activeAgents) + count(candidate.reservedAgents) + count(candidate.pendingLaunches);
  const sample = candidate.memory;
  const observedMs = sample?.observedAt ? Date.parse(sample.observedAt) : NaN;
  const age = Number.isFinite(observedMs) ? (now.getTime() - observedMs) / 1000 : null;
  const available = bytes(sample?.availableBytes);
  const reportedTotal = bytes(sample?.totalBytes);
  const total = reportedTotal !== null && reportedTotal > 0 ? reportedTotal : null;
  const fresh =
    age !== null && age >= -policy.futureSkewSeconds && age <= policy.freshSeconds && available !== null;
  const base: MemoryAssessment = {
    tier: 'unknown',
    admissible: true,
    reason: null,
    available_bytes: available,
    projected_available_bytes: null,
    total_bytes: total,
    available_fraction: available !== null && total !== null ? available / total : null,
    floor_bytes: null,
    need_bytes: need,
    agents_fit: null,
    memory_cap: null,
    held,
    observed_at: sample?.observedAt ?? null,
    age_seconds: age === null ? null : Math.round(age),
    fresh,
  };
  // Unknown or stale memory never refuses a launch (fail open).
  if (!fresh || available === null) return base;

  const floor = floorBytes(policy, candidate.kind, total, candidate.nodeFloorBytes);
  const pending = count(candidate.reservedAgents) + count(candidate.pendingLaunches);
  const projected = available - pending * harnessNeed(policy, null);
  const headroom = projected - floor - need;
  const densityApplies = candidate.maxAgents === 0 || policy.densityCapsConfigured;
  const cap =
    total !== null && densityApplies
      ? Math.max(0, Math.floor((total - floor) / policy.agentSteadyBytes))
      : null;

  const slots = availableSlots(candidate);
  let fit = Math.max(0, Math.floor((projected - floor) / need));
  if (cap !== null) fit = Math.min(fit, Math.max(0, cap - held));
  if (slots !== null) fit = Math.min(fit, slots);

  const assessed = {
    ...base,
    floor_bytes: floor,
    projected_available_bytes: projected,
    agents_fit: fit,
    memory_cap: cap,
  };
  if (cap !== null && held >= cap) return { ...assessed, tier: 'low', admissible: false, reason: 'density' };
  if (headroom < 0) return { ...assessed, tier: 'low', admissible: false, reason: 'available' };
  const ampleBytes = headroom >= policy.ampleHeadroomBytes;
  const ampleShare = total !== null && (projected - need) / total >= policy.ampleFraction;
  const tier: MemoryTier = ampleBytes && ampleShare ? 'ample' : ampleBytes || ampleShare ? 'ok' : 'tight';
  return { ...assessed, tier };
}

/** Binary gigabytes labelled GB, as Activity Monitor and spec sheets show memory ("16 GB"). */
export function formatGigabytes(value: number): string {
  const gb = value / 1024 ** 3;
  return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}

/** The sentence for `spawn_memory_low`, the same on every control plane. */
export function memoryLowMessage(node: string, harness: string, memory: MemoryAssessment): string {
  if (memory.reason === 'density') {
    return (
      `Node "${node}" already runs ${memory.held} agent${memory.held === 1 ? '' : 's'}, the most its ` +
      `${memory.total_bytes === null ? '' : `${formatGigabytes(memory.total_bytes)} of `}memory supports.`
    );
  }
  const free = memory.projected_available_bytes ?? memory.available_bytes ?? 0;
  return (
    `Node "${node}" has ${formatGigabytes(Math.max(0, free))} free; launching ${harness} needs ` +
    `${formatGigabytes(memory.need_bytes)} on top of the ${formatGigabytes(memory.floor_bytes ?? 0)} it keeps free.`
  );
}

/** A short clause for a target's `why`, or null when there is nothing worth saying. */
export function memoryClause(memory: MemoryAssessment, harness: string | null | undefined): string | null {
  if (memory.tier === 'unknown')
    return memory.fresh || memory.observed_at === null ? null : 'Its memory reading is out of date.';
  const free = formatGigabytes(Math.max(0, memory.projected_available_bytes ?? memory.available_bytes ?? 0));
  const of = memory.total_bytes === null ? '' : ` of ${formatGigabytes(memory.total_bytes)}`;
  if (memory.tier === 'low') {
    return memory.reason === 'density'
      ? `Not enough memory for another agent: it already runs ${memory.held}, the most its memory supports.`
      : `Not enough memory: ${free} free${of}; it keeps ${formatGigabytes(memory.floor_bytes ?? 0)} free and ` +
          `${harness ?? 'an agent'} needs ${formatGigabytes(memory.need_bytes)}.`;
  }
  if (memory.tier === 'tight') return `Memory is tight: ${free} free${of}.`;
  return `${free} free${of}.`;
}
