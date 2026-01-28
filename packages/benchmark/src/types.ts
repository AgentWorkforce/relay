/**
 * Benchmark Types
 *
 * Type definitions for the agent swarm performance benchmark system.
 */

/**
 * Configuration type for benchmark runs
 */
export type ConfigurationType = 'single' | 'subagent' | 'swarm';

/**
 * Task complexity level
 */
export type TaskComplexity = 'low' | 'medium' | 'high';

/**
 * A benchmark task definition
 */
export interface Task {
  /** Unique task identifier */
  id: string;
  /** Human-readable task description */
  description: string;
  /** Files the task operates on */
  files: string[];
  /** Success criteria for the task */
  expectedOutcome: string;
  /** Optional Harbor-style success criteria key for compatibility */
  success_criteria?: string;
  /** Task complexity level */
  complexity: TaskComplexity;
  /** Optional timeout in milliseconds (default: 300000 = 5 min) */
  timeoutMs?: number;
  /** Optional tags for categorization */
  tags?: string[];
}

/**
 * Result of a single benchmark run
 */
export interface RunResult {
  /** Task identifier */
  taskId: string;
  /** Configuration used for this run */
  configuration: ConfigurationType;

  // Performance metrics
  /** Total time from start to completion in milliseconds */
  totalTimeMs: number;
  /** Time to first agent action in milliseconds */
  timeToFirstActionMs: number;

  // Communication metrics (multi-agent only)
  /** Total number of inter-agent messages */
  messageCount: number;
  /** Average message latency in milliseconds */
  avgLatencyMs: number;
  /** P50 latency in milliseconds */
  latencyP50Ms: number;
  /** P99 latency in milliseconds */
  latencyP99Ms: number;
  /** Number of coordination rounds */
  coordinationRounds: number;

  // Resource metrics
  /** Number of agents used */
  agentCount: number;
  /** Total tokens consumed (if available) */
  totalTokensUsed: number;
  /** Peak memory usage in MB */
  peakMemoryMb: number;

  // Outcome metrics
  /** Whether the task completed successfully */
  success: boolean;
  /** Completion rate (0-1) for partial success */
  completionRate: number;
  /** Error messages if any */
  errors: string[];

  // Metadata
  /** Timestamp when the run started */
  startedAt: number;
  /** Timestamp when the run completed */
  completedAt: number;
}

/**
 * Comparison result across all configurations
 */
export interface ComparisonResult {
  /** Task identifier */
  taskId: string;
  /** Results for each configuration */
  results: Map<ConfigurationType, RunResult>;
  /** The winning configuration based on scoring */
  winner: ConfigurationType;
  /** Score breakdown for each configuration */
  scores: Map<ConfigurationType, ScoreBreakdown>;
}

/**
 * Score breakdown for a configuration
 */
export interface ScoreBreakdown {
  /** Total score (0-100) */
  total: number;
  /** Success component (0-50) */
  successScore: number;
  /** Time efficiency component (0-30) */
  timeScore: number;
  /** Resource efficiency component (0-20) */
  efficiencyScore: number;
}

/**
 * Benchmark configuration options
 */
export interface BenchmarkConfig {
  /** Which configurations to run */
  configurations: ConfigurationType[];
  /** CLI to use for agents (default: 'claude') */
  cli: string;
  /** Working directory for tasks */
  cwd?: string;
  /** Suppress console output */
  quiet: boolean;
  /** Cool-down time between runs in milliseconds */
  cooldownMs: number;
  /** Maximum concurrent agents for swarm */
  maxSwarmSize: number;
  /** Custom socket path for relay */
  socketPath?: string;
}

/**
 * Default benchmark configuration
 */
export const DEFAULT_BENCHMARK_CONFIG: BenchmarkConfig = {
  configurations: ['single', 'subagent', 'swarm'],
  cli: 'claude',
  quiet: false,
  cooldownMs: 5000,
  maxSwarmSize: 10,
};

/**
 * Metrics collected during a run
 */
export interface RunMetrics {
  /** Number of messages sent */
  messages: number;
  /** Message latencies in milliseconds */
  latencies: number[];
  /** Run start timestamp */
  startTime: number;
  /** Spawned agent names */
  spawnedAgents: string[];
  /** Error events */
  errors: string[];
}

/**
 * Task dataset definition
 */
export interface TaskDataset {
  /** Dataset name */
  name: string;
  /** Dataset description */
  description?: string;
  /** Version identifier */
  version?: string;
  /** Tasks in the dataset */
  tasks: Task[];
}

/**
 * Harbor-compatible evaluation input
 */
export interface HarborTaskInput {
  id: string;
  description: string;
  files?: string[];
  success_criteria?: string;
  complexity?: TaskComplexity;
  agents_required?: number;
  [key: string]: unknown;
}

/**
 * Harbor-compatible evaluation output
 */
export interface HarborEvaluationOutput {
  task_id: string;
  configurations: Record<ConfigurationType, RunResult>;
  winner: ConfigurationType;
  scores: Record<ConfigurationType, ScoreBreakdown>;
  metadata: {
    benchmark_version: string;
    started_at: number;
    completed_at: number;
    total_duration_ms: number;
  };
}
