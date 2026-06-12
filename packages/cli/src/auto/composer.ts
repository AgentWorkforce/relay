/**
 * Team composer for auto-routing.
 *
 * Maps a TaskAssessment to a concrete TeamSpec using a routing table derived
 * from lifecycle eval data (s01–s04). The routing table is a pure data
 * structure — update it as eval pass rates change.
 *
 * Key invariants (empirically verified by eval suite):
 *   - Haiku is worker-only. It is never selected as lead.
 *   - Sonnet + one-liner onboarding = 100% lifecycle reliability → default lead.
 *   - Opus lead only for high complexity (capable but verbose/expensive).
 *   - Worker model matches subtask complexity, not overall task complexity.
 */
import type { TaskAssessment } from './classifier.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export type OnboardingVariant = 'bare' | 'one-liner' | 'brief' | 'skill';

export interface WorkerSpec {
  role: string;
  model: ModelTier;
  task: string;
}

export interface TeamSpec {
  lead: {
    model: ModelTier;
    onboarding: OnboardingVariant;
  };
  workers: WorkerSpec[];
}

// ── Routing table ─────────────────────────────────────────────────────────────
// Derived from lifecycle eval data (b3oqx02zv + subsequent s03 runs).
// Format: [complexity, parallelizable] → [lead tier, lead onboarding, worker tier]
type RoutingKey = `${'low' | 'medium' | 'high'}:${'serial' | 'parallel'}`;

interface RoutingRow {
  leadModel: ModelTier;
  leadOnboarding: OnboardingVariant;
  workerModel: ModelTier;
  /** Use a sonnet "synthesiser" worker as the final aggregator for parallel teams. */
  synth?: boolean;
}

const ROUTING_TABLE: Record<RoutingKey, RoutingRow> = {
  // Low complexity: sonnet lead coordinates one haiku worker (cheapest reliable setup).
  'low:serial':    { leadModel: 'sonnet', leadOnboarding: 'one-liner', workerModel: 'haiku' },
  'low:parallel':  { leadModel: 'sonnet', leadOnboarding: 'one-liner', workerModel: 'haiku' },

  // Medium: sonnet lead + sonnet workers for quality; add synthesiser when parallel.
  'medium:serial':   { leadModel: 'sonnet', leadOnboarding: 'one-liner', workerModel: 'sonnet' },
  'medium:parallel': { leadModel: 'sonnet', leadOnboarding: 'one-liner', workerModel: 'haiku', synth: true },

  // High: opus lead (capable natively, bare onboarding) + sonnet workers for depth.
  'high:serial':   { leadModel: 'opus', leadOnboarding: 'bare', workerModel: 'sonnet' },
  'high:parallel': { leadModel: 'opus', leadOnboarding: 'bare', workerModel: 'sonnet', synth: false },
};

// ── Composer ─────────────────────────────────────────────────────────────────

/**
 * Map a TaskAssessment to a TeamSpec using the routing table.
 * Pure function — no I/O, no LLM call.
 */
export function composeTeam(assessment: TaskAssessment, originalTask: string): TeamSpec {
  const { complexity, parallelizable, estimatedWorkers, subtasks, domains } = assessment;
  const key: RoutingKey = `${complexity}:${parallelizable ? 'parallel' : 'serial'}`;
  const row = ROUTING_TABLE[key];

  // Build worker specs from the inferred subtask list.
  const baseWorkers: WorkerSpec[] = subtasks
    .slice(0, estimatedWorkers)
    .map((subtask, i) => {
      const domain = domains[i] ?? 'general';
      return {
        role: `Worker-${domain.charAt(0).toUpperCase() + domain.slice(1)}`,
        model: row.workerModel,
        task: `You are a specialised ${domain} worker. Your task:\n\n${originalTask}\n\nFocus exclusively on the ${subtask}. Report DONE when complete with a concise summary.`,
      };
    });

  // Add a synthesiser worker for parallel medium-complexity tasks.
  const workers: WorkerSpec[] =
    row.synth
      ? [
          ...baseWorkers,
          {
            role: 'Worker-Synthesiser',
            model: 'sonnet',
            task: `You are a synthesis worker. Wait for all other workers to report DONE, then synthesise their findings into a single coherent summary for the lead. Report DONE when the synthesis is complete.`,
          },
        ]
      : baseWorkers;

  return {
    lead: { model: row.leadModel, onboarding: row.leadOnboarding },
    workers,
  };
}
