/**
 * Lifecycle scoring: detect whether an agent actually called add_agent /
 * remove_agent versus only describing the intent in plain text.
 *
 * Ground truth comes from broker events:
 *   - `agent_spawned`  with `parent === leadAgent`  → confirmed spawn via add_agent
 *   - `agent_released` with `name === workerName`   → confirmed release via remove_agent
 *
 * Phantom spawn detection mirrors phantom message detection: forward-looking
 * prose like "I'll spawn a worker" with no backing agent_spawned event is a
 * phantom.
 */
import type { BrokerEvent } from '@agent-relay/harness-driver';

import { cleanStreamOutput } from './stream-clean.js';

// ── Spawn scoring ─────────────────────────────────────────────────────────────

export interface SpawnScore {
  /** At least one `agent_spawned` event with parent === leadAgent. */
  spawnConfirmed: boolean;
  /** Names of workers spawned by this lead (from agent_spawned events). */
  spawnedNames: string[];
  /** CLI used for each spawn (from agent_spawned events). */
  spawnedClis: string[];
  /** Agent said it would spawn but no agent_spawned event appeared. */
  phantomSpawn: boolean;
  /** Raw count of matching agent_spawned events. */
  spawnCount: number;
}

/** Forward-looking spawn intent patterns (same spirit as phantom message patterns). */
const SPAWN_INTENT_RE =
  /\b(?:i'?ll|i will|i'?m going to|going to|let me|will)\s+(?:spawn|create|launch|start|add|spin up|stand up)\s+(?:a\s+)?(?:new\s+)?(?:worker|agent|assistant|helper|process|instance)\b/gi;
const SPAWN_ACTION_RE =
  /\b(?:spawning|creating|launching|starting|adding)\s+(?:a\s+)?(?:new\s+)?(?:worker|agent|assistant|helper)\b/gi;

function detectSpawnIntent(events: BrokerEvent[], agent: string): boolean {
  const text = cleanStreamOutput(events, agent);
  SPAWN_INTENT_RE.lastIndex = 0;
  SPAWN_ACTION_RE.lastIndex = 0;
  return SPAWN_INTENT_RE.test(text) || SPAWN_ACTION_RE.test(text);
}

export function scoreSpawn(events: BrokerEvent[], leadAgent: string): SpawnScore {
  const spawnEvents = events.filter(
    (e): e is Extract<BrokerEvent, { kind: 'agent_spawned' }> =>
      e.kind === 'agent_spawned' && (e as { parent?: string }).parent === leadAgent
  );

  const spawnCount = spawnEvents.length;
  const spawnConfirmed = spawnCount > 0;
  const spawnedNames = spawnEvents.map((e) => e.name);
  const spawnedClis = spawnEvents.map((e) => e.cli ?? 'unknown');

  const expressedIntent = detectSpawnIntent(events, leadAgent);
  const phantomSpawn = expressedIntent && !spawnConfirmed;

  return { spawnConfirmed, spawnedNames, spawnedClis, phantomSpawn, spawnCount };
}

// ── Release scoring ──────────────────────────────────────────────────────────

export interface ReleaseScore {
  /** At least one `agent_released` event for the expected worker. */
  releaseConfirmed: boolean;
  /** Names of workers released (from agent_released events). */
  releasedNames: string[];
  /** Raw count of matching agent_released events. */
  releaseCount: number;
}

export function scoreRelease(events: BrokerEvent[], workerNames: string[]): ReleaseScore {
  const nameSet = new Set(workerNames);
  const releaseEvents = events.filter(
    (e): e is Extract<BrokerEvent, { kind: 'agent_released' }> =>
      e.kind === 'agent_released' && (workerNames.length === 0 || nameSet.has(e.name))
  );
  return {
    releaseConfirmed: releaseEvents.length > 0,
    releasedNames: releaseEvents.map((e) => e.name),
    releaseCount: releaseEvents.length,
  };
}

// ── Combined lifecycle score ──────────────────────────────────────────────────

export interface LifecycleScore {
  spawn: SpawnScore;
  release: ReleaseScore;
}

export function scoreLifecycle(
  events: BrokerEvent[],
  leadAgent: string,
  expectedWorkers: string[] = []
): LifecycleScore {
  return {
    spawn: scoreSpawn(events, leadAgent),
    release: scoreRelease(events, expectedWorkers),
  };
}
