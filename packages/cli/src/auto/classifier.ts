/**
 * Task classifier for auto-routing.
 *
 * Assesses a task description and returns a structured assessment that drives
 * model-tier selection and team composition. Phase 1 uses a heuristic approach
 * (no extra LLM call). Replace with an LLM call if heuristic accuracy is
 * insufficient for production workloads.
 */

export interface TaskAssessment {
  complexity: 'low' | 'medium' | 'high';
  parallelizable: boolean;
  /** Inferred natural sub-units (max 6). */
  subtasks: string[];
  /** Domain labels inferred from the task description. */
  domains: string[];
  /** How many parallel workers would help (1 = serial). Capped at 6. */
  estimatedWorkers: number;
  /** Short explanation for transparency / debugging. */
  reasoning: string;
}

// ── Complexity keywords ───────────────────────────────────────────────────────

const HIGH_COMPLEXITY_KEYWORDS = [
  'audit', 'refactor', 'migrate', 'redesign', 'overhaul', 'architecture',
  'security review', 'performance analysis', 'comprehensive', 'full ',
  'entire ', 'across all', 'end-to-end', 'investigation', 'root cause',
  'diagnose', 'large-scale', 'multi-phase', 'research',
];

const MEDIUM_COMPLEXITY_KEYWORDS = [
  'implement', 'build', 'add', 'create', 'update', 'fix', 'debug',
  'integrate', 'configure', 'deploy', 'analyse', 'analyze', 'review',
  'test', 'document', 'optimize', 'optimise',
];

// ── Parallelism signals ───────────────────────────────────────────────────────

const PARALLEL_PHRASES = [
  ' and ', ' also ', 'at the same time', 'in parallel', 'simultaneously',
  'concurrently', 'both ', 'each ', 'all ', 'multiple ',
];

// ── Domain detection ─────────────────────────────────────────────────────────

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  backend:    ['api', 'server', 'service', 'database', 'db', 'query', 'endpoint', 'rest', 'graphql'],
  frontend:   ['ui', 'ux', 'component', 'page', 'react', 'vue', 'css', 'style', 'layout', 'interface'],
  testing:    ['test', 'spec', 'coverage', 'unit', 'integration', 'e2e', 'qa'],
  security:   ['auth', 'authentication', 'security', 'vulnerability', 'permission', 'access', 'credential'],
  devops:     ['deploy', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes', 'infra', 'cloud', 'monitor'],
  data:       ['data', 'etl', 'pipeline', 'schema', 'migration', 'report', 'analytics'],
  docs:       ['document', 'readme', 'wiki', 'guide', 'changelog'],
  mobile:     ['mobile', 'ios', 'android', 'react native', 'flutter'],
};

// ── Classifier ────────────────────────────────────────────────────────────────

function detectDomains(task: string): string[] {
  const lower = task.toLowerCase();
  return Object.entries(DOMAIN_KEYWORDS)
    .filter(([, kw]) => kw.some((k) => lower.includes(k)))
    .map(([domain]) => domain);
}

function countParallelSignals(task: string): number {
  const lower = task.toLowerCase();
  return PARALLEL_PHRASES.filter((p) => lower.includes(p)).length;
}

function wordCount(task: string): number {
  return task.trim().split(/\s+/).length;
}

/**
 * Classify a task using heuristics — no LLM call, <1ms, zero API cost.
 *
 * Accuracy is sufficient for routing (low/medium/high is a 3-bucket decision).
 * Replace the body with an LLM call for finer-grained subtask extraction if
 * accuracy data shows heuristics under-perform.
 */
export function classifyTask(task: string): TaskAssessment {
  const lower = task.toLowerCase();
  const words = wordCount(task);
  const domains = detectDomains(task);
  const parallelSignals = countParallelSignals(task);
  const parallelizable = parallelSignals >= 2 || domains.length >= 3;

  // ── Complexity ──────────────────────────────────────────────────────────────
  let complexity: TaskAssessment['complexity'];
  const highHit = HIGH_COMPLEXITY_KEYWORDS.some((kw) => lower.includes(kw));
  const medHit  = MEDIUM_COMPLEXITY_KEYWORDS.some((kw) => lower.includes(kw));

  if (highHit || words > 100 || domains.length >= 4) {
    complexity = 'high';
  } else if (medHit || words > 40 || domains.length >= 2) {
    complexity = 'medium';
  } else {
    complexity = 'low';
  }

  // ── Subtask estimation ──────────────────────────────────────────────────────
  // Heuristic: one subtask per domain detected, min 1, max 6.
  const estimatedWorkers = Math.min(Math.max(domains.length, 1), 6);

  // ── Subtask labels ──────────────────────────────────────────────────────────
  const subtasks =
    domains.length > 0
      ? domains.map((d) => `${d} work`)
      : ['primary task'];

  // ── Reasoning ──────────────────────────────────────────────────────────────
  const reasoning =
    `${words}-word task; complexity=${complexity} (` +
    `highKw=${highHit}, medKw=${medHit}, words=${words}, domains=${domains.length}); ` +
    `parallelizable=${parallelizable} (signals=${parallelSignals}, domains=${domains.length}); ` +
    `domains=[${domains.join(', ')}]`;

  return { complexity, parallelizable, subtasks, domains, estimatedWorkers, reasoning };
}
