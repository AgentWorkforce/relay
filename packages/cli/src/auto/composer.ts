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
 *   - For codex workers, prefer gpt-5.5 or gpt-5.4-mini. See CODEX_MODEL_TIERS.
 */
import type { TaskAssessment } from './classifier.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';
export type OnboardingVariant = 'bare' | 'one-liner' | 'brief' | 'skill';

/**
 * Which CLI harness to use for a worker.
 * 'claude' = default (direct Anthropic API via claude CLI).
 * 'codex'  = OpenAI codex CLI; pair with a codexModel from CODEX_MODEL_TIERS.
 * Future: 'opencode', 'gemini', 'droid' once opencode model evals complete.
 */
export type WorkerCli = 'claude' | 'codex';

export interface WorkerSpec {
  role: string;
  model: ModelTier;
  task: string;
  /** Override CLI harness. Defaults to 'claude'. */
  cli?: WorkerCli;
  /** For codex workers: the OpenAI model name to pass via --model. */
  codexModel?: string;
}

export interface TeamSpec {
  lead: {
    model: ModelTier;
    onboarding: OnboardingVariant;
  };
  workers: WorkerSpec[];
}

// ── Codex model tier data (from lifecycle eval 2026-06-12) ───────────────────
// s01–s04, 5 runs each, 4 onboarding variants.
// Use this to pick the right codex model when spawning codex workers.
export const CODEX_MODEL_TIERS = {
  /**
   * gpt-5.5 — best. 16/16 scenarios PASS, 100% s03 one-liner+, 100% s04 all.
   * Recommended default for codex workers.
   */
  recommended: 'gpt-5.5',

  /**
   * gpt-5.4-mini — viable budget tier. 15/16 scenarios PASS (only s03:skill fails).
   * 100% s03 bare/one-liner, 80% brief/skill. 80–100% s04. Use bare or one-liner
   * onboarding for best results. phantom=31% (slightly noisy).
   */
  budget: 'gpt-5.4-mini',

  /**
   * gpt-5.4 — avoid. 16/16 scenarios PASS on majority-vote but phantom=52% (14
   * phantom agents) and per-run reliability is 60% across s03/s04 variants.
   * The config migration alias `gpt-5.4 → gpt-5.5` does NOT apply at runtime —
   * these are distinct models with significantly different behaviour.
   */
  avoid: 'gpt-5.4',

  /**
   * gpt-5.3-codex-spark — not viable. 6/16 scenarios PASS. Fails s03 one-liner/
   * brief/skill, s04 one-liner/brief. Ultra-fast but sacrifices relay reliability.
   */
  notViable: 'gpt-5.3-codex-spark',
} as const;

// Onboarding recommendations per harness (from s01–s04 eval data 2026-06-12).
// Used by the Director meta-prompt builder to select the right onboarding text.
export const HARNESS_ONBOARDING: Record<string, OnboardingVariant> = {
  claude:    'one-liner', // sonnet: 100% s03; haiku: needs skill (broker injects SMALL_MODEL_RELAY_SKILL)
  codex:     'bare',      // relay-native; bare s03=80%, one-liner=100% — bare saves tokens
  opencode:  'bare',      // relay-native; bare s03=100% (best bare of all harnesses)
  gemini:    'one-liner', // bare s03=60% (release failures); one-liner=100%
  droid:     'bare',      // bare s03=100%; NEVER use skill (kills s03 to 0%)
};

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
        task: `You are a specialised ${domain} relay worker. Your task:\n\n${originalTask}\n\nFocus exclusively on the ${subtask}. Report DONE when complete with a concise summary.`,
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
            task: `You are a synthesis relay worker. Wait for all other relay workers to report DONE, then synthesise their findings into a single coherent summary for the lead. Report DONE when the synthesis is complete.`,
          },
        ]
      : baseWorkers;

  return {
    lead: { model: row.leadModel, onboarding: row.leadOnboarding },
    workers,
  };
}
