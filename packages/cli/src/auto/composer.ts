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
 * Which CLI harness to use for an agent.
 * Extend as opencode model evals complete and confirm role fitness.
 */
export type WorkerCli = 'claude' | 'codex' | 'opencode' | 'gemini' | 'droid';

/**
 * Roles from the choosing-swarm-patterns skill.
 * Each role slot in a pattern is filled by a harness+model with confirmed fitness.
 */
export type AgentRole =
  | 'lead'        // orchestrates pre-spawned team, DMs workers, aggregates
  | 'coordinator' // mid-level lead; manages sub-teams
  | 'worker'      // executes one bounded task, self-reports DONE
  | 'planner'     // produces structured plan (non-interactive ok)
  | 'reviewer'    // produces structured critique with pass/fail verdict
  | 'critic'      // synonym for reviewer in reflection pattern
  | 'verifier'    // checks evidence, gates on condition
  | 'judge'       // adjudicates between competing outputs
  | 'mapper'      // processes one item from a list (non-interactive leaf)
  | 'reducer'     // aggregates mapper outputs
  | 'supervisor'  // monitors workers, can intervene
  | 'debater';    // argues a position in adversarial exchange

/**
 * Role fitness for a harness+model combination.
 * Derived from lifecycle eval pass rates (s01–s06).
 *
 * Fitness levels:
 *   'confirmed' — s03+s04 ≥5 full-repeat runs pass reliably
 *   'provisional' — passes but with caveats (phantom rate, onboarding dependency)
 *   'not-viable' — fails lifecycle or not relay-native
 *   'untested' — eval not yet run
 */
export type RoleFitness = 'confirmed' | 'provisional' | 'not-viable' | 'untested';

export interface RoleFitEntry {
  fitness: RoleFitness;
  notes?: string;
}

export interface HarnessRoleMap {
  harness: string;            // e.g. 'codex', 'opencode:mimo-v2.5-free'
  defaultModel?: string;      // for harnesses with selectable models
  roles: Partial<Record<AgentRole, RoleFitEntry>>;
  bestOnboarding: OnboardingVariant;
  relayNative: boolean;       // s04 pass — won't use native subagent tools
}

export interface WorkerSpec {
  role: AgentRole | string;
  model: ModelTier;
  task: string;
  /** Override CLI harness. Defaults to 'claude'. */
  cli?: WorkerCli;
  /** For codex workers: the OpenAI model name to pass via --model. */
  codexModel?: string;
  /** For opencode workers: the opencode model suffix. */
  opencodeModel?: string;
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

// ── Role-fit map (from eval data 2026-06-12) ──────────────────────────────────
// Maps each harness to which roles it can reliably fill in swarm patterns.
// Update as eval data comes in. 'untested' = opencode batch eval pending.
// See specs/auto-routing.md §5 for the full role-fit table and what s07+ will add.
export const HARNESS_ROLE_MAP: HarnessRoleMap[] = [
  {
    harness: 'codex',
    defaultModel: 'gpt-5.5',
    bestOnboarding: 'bare',
    relayNative: true,
    roles: {
      worker:      { fitness: 'confirmed', notes: 's03 100% all variants' },
      coordinator: { fitness: 'confirmed', notes: 's03+s04 100%; viable lead for pre-spawned teams' },
      planner:     { fitness: 'confirmed', notes: 's03 non-interactive ok; relay-native' },
      reviewer:    { fitness: 'confirmed', notes: 's04 100%; relay-native; never routes to native tools' },
      mapper:      { fitness: 'confirmed', notes: 'interactive:false reliable' },
      reducer:     { fitness: 'confirmed', notes: 'interactive:false reliable' },
      verifier:    { fitness: 'confirmed' },
      judge:       { fitness: 'provisional', notes: 'untested for multi-input adjudication' },
      debater:     { fitness: 'provisional', notes: 'relay-native but adversarial exchange untested' },
    },
  },
  {
    harness: 'claude',
    defaultModel: 'sonnet',
    bestOnboarding: 'one-liner',
    relayNative: false,
    roles: {
      lead:        { fitness: 'confirmed', notes: 'sonnet one-liner=100%; opus bare=67%' },
      coordinator: { fitness: 'confirmed', notes: 'sonnet is default lead; opus for high-complexity' },
      worker:      { fitness: 'confirmed', notes: 'sonnet one-liner=100%; haiku worker-only' },
      reviewer:    { fitness: 'confirmed', notes: 'sonnet/opus strong reviewers' },
      critic:      { fitness: 'confirmed' },
      judge:       { fitness: 'confirmed', notes: 'opus preferred for high-stakes adjudication' },
      debater:     { fitness: 'confirmed', notes: 'sonnet/opus capable of adversarial exchange' },
      planner:     { fitness: 'confirmed' },
      mapper:      { fitness: 'confirmed', notes: 'haiku viable for simple map tasks' },
      reducer:     { fitness: 'confirmed' },
      supervisor:  { fitness: 'confirmed', notes: 'sonnet+ only; haiku not viable as supervisor' },
      verifier:    { fitness: 'confirmed' },
    },
  },
  {
    harness: 'opencode',
    defaultModel: 'mimo-v2.5-free',
    bestOnboarding: 'bare',
    relayNative: true,
    roles: {
      worker:      { fitness: 'confirmed', notes: 'mimo s03 bare=100%; best bare result of all harnesses' },
      planner:     { fitness: 'confirmed' },
      mapper:      { fitness: 'confirmed' },
      reducer:     { fitness: 'confirmed' },
      coordinator: { fitness: 'provisional', notes: 's03+s04 good; multi-DM coordination untested' },
      reviewer:    { fitness: 'provisional', notes: 'relay-native; structured verdict format untested' },
      // Models from opencode batch eval: fitness will be updated per-model as results arrive.
      // deepseek-v4-*/kimi-*/qwen-*/minimax-*/glm-* roles all 'untested' until Phase 1+2 complete.
    },
  },
  {
    harness: 'gemini',
    defaultModel: undefined,
    bestOnboarding: 'one-liner',
    relayNative: false,
    roles: {
      worker:      { fitness: 'confirmed', notes: 'one-liner s03=100%; bare=60%' },
      planner:     { fitness: 'provisional', notes: 'relay-native when prompted; avoid relay-agent vocab' },
      mapper:      { fitness: 'confirmed', notes: 'one-liner+ reliable' },
      reducer:     { fitness: 'provisional' },
      coordinator: { fitness: 'provisional', notes: 's04=60-80%; occasional native fallback' },
      reviewer:    { fitness: 'provisional' },
    },
  },
  {
    harness: 'droid',
    defaultModel: undefined,
    bestOnboarding: 'bare',
    relayNative: false,
    roles: {
      worker:      { fitness: 'confirmed', notes: 's03 bare=100% with directive phrasing' },
      mapper:      { fitness: 'confirmed', notes: 'leaf-only; no spawning tasks' },
      planner:     { fitness: 'provisional' },
      // NEVER use for roles that involve spawning: s04=0% bare/one-liner
      coordinator: { fitness: 'not-viable', notes: 's04=0%; routes to native Task tool' },
      supervisor:  { fitness: 'not-viable', notes: 'would use native Task, not relay' },
    },
  },
  {
    harness: 'grok',
    defaultModel: undefined,
    bestOnboarding: 'bare',
    relayNative: false,
    roles: {
      worker:      { fitness: 'not-viable', notes: '0/48 — model does not call relay MCP tools' },
      coordinator: { fitness: 'not-viable' },
    },
  },
  {
    harness: 'cursor-agent',
    defaultModel: undefined,
    bestOnboarding: 'bare',
    relayNative: false,
    roles: {
      worker:      { fitness: 'not-viable', notes: '0/48 — model does not call relay MCP tools' },
      coordinator: { fitness: 'not-viable' },
    },
  },
];

/**
 * Look up which harnesses can fill a given role at 'confirmed' or better fitness.
 * Use to populate role slots when composing teams for specific swarm patterns.
 */
export function harnessesForRole(role: AgentRole): HarnessRoleMap[] {
  return HARNESS_ROLE_MAP.filter(h => {
    const entry = h.roles[role];
    return entry?.fitness === 'confirmed' || entry?.fitness === 'provisional';
  });
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
