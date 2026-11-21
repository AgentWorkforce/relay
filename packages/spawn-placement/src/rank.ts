/**
 * Ranking and alternatives over normalized candidates. Permission, parsing
 * and wording stay with each control plane; the order is decided here.
 */

import {
  assessMemory,
  availableSlots,
  type MemoryAssessment,
  type MemoryTier,
  type PlacementCandidate,
} from './memory.js';
import type { MemoryPolicy, NodeKind } from './policy.js';

export const MAX_ALTERNATIVES = 3;
const KIND_ORDER: Record<NodeKind, number> = { desktop: 0, broker: 1, hosted: 2 };
/** `unknown` sits between `ok` and `tight`: not ahead of a node known healthy, not behind one known short. */
const TIER_ORDER: Record<MemoryTier, number> = { ample: 0, ok: 1, unknown: 2, tight: 3, low: 4 };

export interface RankedCandidate<T extends PlacementCandidate = PlacementCandidate> {
  candidate: T;
  memory: MemoryAssessment;
  /** Offers the named harness, has slot room and, when the policy ranks by memory, enough memory. */
  admissible: boolean;
}

export interface RankOptions {
  harness?: string | null;
  policy: MemoryPolicy;
  now: Date;
}

/** Whether memory changes ranking, alternatives and admission (`rank`, `enforce`). */
export function memoryRanks(policy: MemoryPolicy): boolean {
  return policy.mode === 'rank' || policy.mode === 'enforce';
}

function hasRoom(candidate: PlacementCandidate): boolean {
  const slots = availableSlots(candidate);
  return slots === null || slots > 0;
}

/** Load per CPU when the machine reports it, else Relaycast's slot utilization; unknown sorts last. */
export function loadScore(candidate: PlacementCandidate): number {
  if (candidate.load1m !== null && candidate.load1m !== undefined && candidate.cpus)
    return candidate.load1m / candidate.cpus;
  return candidate.utilization ?? Number.POSITIVE_INFINITY;
}

function byLoad(a: PlacementCandidate, b: PlacementCandidate): number {
  const left = loadScore(a);
  const right = loadScore(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Today's order, unchanged: allowed; yours; desktop, broker, hosted; room;
 * lowest load; more finite free slots. Used in `off` and `observe`.
 */
export function compareLegacy(a: PlacementCandidate, b: PlacementCandidate): number {
  const slots = (candidate: PlacementCandidate) => availableSlots(candidate) ?? 0;
  return (
    Number(b.allowed) - Number(a.allowed) ||
    Number(b.isYours) - Number(a.isYours) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    Number(hasRoom(b)) - Number(hasRoom(a)) ||
    byLoad(a, b) ||
    slots(b) - slots(a)
  );
}

/**
 * Memory-aware order (`rank`, `enforce`): allowed; admissible (room and
 * memory); yours; kind; memory tier; lowest load; fewer held agents; more
 * agents that fit; more free slots. The first entry is a target that would
 * take the launch now, whenever one would.
 */
export function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  const fit = (entry: RankedCandidate) => entry.memory.agents_fit ?? -1;
  const slots = (entry: RankedCandidate) => availableSlots(entry.candidate) ?? 0;
  return (
    Number(b.candidate.allowed) - Number(a.candidate.allowed) ||
    Number(b.admissible) - Number(a.admissible) ||
    Number(b.candidate.isYours) - Number(a.candidate.isYours) ||
    KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind] ||
    TIER_ORDER[a.memory.tier] - TIER_ORDER[b.memory.tier] ||
    byLoad(a.candidate, b.candidate) ||
    a.memory.held - b.memory.held ||
    fit(b) - fit(a) ||
    slots(b) - slots(a)
  );
}

/**
 * Best first. Ties keep the input (Relaycast roster) order.
 *
 * Ranks candidates best first and assesses each one's memory.
 *
 * @param candidates Targets in roster order; ties keep this order.
 * @param options The harness to judge memory for, the policy and the clock.
 * @returns One entry per candidate with its memory assessment and admissibility.
 */
export function rankCandidates<T extends PlacementCandidate>(
  candidates: readonly T[],
  options: RankOptions
): Array<RankedCandidate<T>> {
  const ranks = memoryRanks(options.policy);
  const entries = candidates.map((candidate): RankedCandidate<T> => {
    const memory = assessMemory(candidate, options.harness ?? null, options.policy, options.now);
    // A node that does not offer the named harness would not take this launch either.
    const offers = !options.harness || candidate.harnesses.includes(options.harness);
    return { candidate, memory, admissible: offers && hasRoom(candidate) && (!ranks || memory.admissible) };
  });
  return entries.sort((a, b) => (ranks ? compareRanked(a, b) : compareLegacy(a.candidate, b.candidate)));
}

/**
 * Allowed targets that would take the same launch now: they offer the
 * harness, have room and (when memory ranks) enough memory. Ones sharing a
 * repository with the refused target come first. At most three.
 *
 * @param ranked The output of `rankCandidates` for the same harness.
 * @param harness The refused launch's harness.
 * @param refused The refused target's id and repositories.
 * @returns At most three entries that would take the launch now.
 */
export function alternativesFor<T extends PlacementCandidate>(
  ranked: ReadonlyArray<RankedCandidate<T>>,
  harness: string,
  refused: { id: string; repositories?: readonly string[] }
): Array<RankedCandidate<T>> {
  const repositories = new Set(refused.repositories ?? []);
  const fits = ranked.filter(
    (entry) =>
      entry.candidate.allowed &&
      entry.candidate.id !== refused.id &&
      entry.candidate.harnesses.includes(harness) &&
      entry.admissible
  );
  const shares = (entry: RankedCandidate<T>) =>
    entry.candidate.repositories.some((repository) => repositories.has(repository));
  return [...fits.filter(shares), ...fits.filter((entry) => !shares(entry))].slice(0, MAX_ALTERNATIVES);
}

/**
 * The memory refusal for a target, only in `enforce`; null when the launch may proceed.
 *
 * @param entry A ranked target.
 * @param policy The memory policy.
 * @returns The assessment to refuse with, or null.
 */
export function memoryRefusal(entry: RankedCandidate, policy: MemoryPolicy): MemoryAssessment | null {
  return policy.mode === 'enforce' && !entry.memory.admissible ? entry.memory : null;
}

/** Would this target be refused for memory under `enforce`? For `observe`/`rank` shadow counting. */
export function wouldRefuseForMemory(entry: RankedCandidate): boolean {
  return !entry.memory.admissible;
}
