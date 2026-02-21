/**
 * Workflow Types for Relay Cloud Swarm Patterns
 *
 * Shared TypeScript types for relay.yaml configuration, workflow execution,
 * and database row representations.
 */

// ── relay.yaml top-level config ─────────────────────────────────────────────

/** Top-level relay.yaml configuration file structure. */
export interface RelayYamlConfig {
  version: string;
  name: string;
  description?: string;
  swarm: SwarmConfig;
  agents: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  coordination?: CoordinationConfig;
  state?: StateConfig;
  errorHandling?: ErrorHandlingConfig;
  trajectories?: TrajectoryConfig | false;
}

// ── Trajectory configuration ─────────────────────────────────────────────────

/** Configuration for workflow trajectory recording. */
export interface TrajectoryConfig {
  /** Enable trajectory recording (default: true). */
  enabled?: boolean;
  /** Auto-reflect when barriers resolve (default: true). */
  reflectOnBarriers?: boolean;
  /** Auto-reflect when parallel tracks converge (default: true). */
  reflectOnConverge?: boolean;
  /** Record retry/skip/fail decisions automatically (default: true). */
  autoDecisions?: boolean;
}

// ── Swarm configuration ─────────────────────────────────────────────────────

/** Configuration for idle agent detection and nudging. */
export interface IdleNudgeConfig {
  /** ms after idle detection before first nudge (default: 120_000 = 2 min). */
  nudgeAfterMs?: number;
  /** ms after nudge before force-release (default: 120_000 = 2 min). */
  escalateAfterMs?: number;
  /** Max nudges before escalation (default: 1). */
  maxNudges?: number;
}

/** Swarm-level settings controlling the overall pattern. */
export interface SwarmConfig {
  pattern: SwarmPattern;
  maxConcurrency?: number;
  timeoutMs?: number;
  channel?: string;
  /** Idle agent detection and nudging configuration for interactive agents. */
  idleNudge?: IdleNudgeConfig;
}

export type SwarmPattern =
  | "fan-out"
  | "pipeline"
  | "hub-spoke"
  | "consensus"
  | "mesh"
  | "handoff"
  | "cascade"
  | "dag"
  | "debate"
  | "hierarchical"
  // Additional patterns
  | "map-reduce"
  | "scatter-gather"
  | "supervisor"
  | "reflection"
  | "red-team"
  | "verifier"
  | "auction"
  | "escalation"
  | "saga"
  | "circuit-breaker"
  | "blackboard"
  | "swarm"
  | "competitive";

// ── Agent definitions ───────────────────────────────────────────────────────

/** Definition of an agent participating in a workflow. */
export interface AgentDefinition {
  name: string;
  cli: AgentCli;
  role?: string;
  task?: string;
  channels?: string[];
  constraints?: AgentConstraints;
  /** When false, the agent runs as a non-interactive subprocess (no PTY, no relay messaging).
   *  It receives its task as a CLI prompt argument and returns stdout as output.
   *  Default: true (interactive PTY mode). */
  interactive?: boolean;
}

export type AgentCli = "claude" | "codex" | "gemini" | "aider" | "goose" | "opencode" | "droid";

/** Resource and behavioral constraints for an agent. */
export interface AgentConstraints {
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  model?: string;
  /** Silence duration in seconds before the agent is considered idle (0 = disabled, default: 30). */
  idleThresholdSecs?: number;
}

// ── Workflow definitions ────────────────────────────────────────────────────

/** Preflight check that runs before any workflow steps. */
export interface PreflightCheck {
  /** Shell command to execute. */
  command: string;
  /** Fail if output matches this condition: "non-empty", "empty", or a regex pattern. */
  failIf?: "non-empty" | "empty" | string;
  /** Succeed only if output matches this condition. */
  successIf?: string;
  /** Human-readable description of what this check validates. */
  description?: string;
}

/** A named workflow composed of sequential or parallel steps. */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  /** Preflight checks that run before any steps. All must pass. */
  preflight?: PreflightCheck[];
  steps: WorkflowStep[];
  onError?: "fail" | "skip" | "retry";
}

/** Step type: agent (LLM-powered) or deterministic (shell command). */
export type WorkflowStepType = "agent" | "deterministic";

/**
 * A single step within a workflow.
 *
 * Steps can be either:
 * - Agent steps (type: undefined or "agent"): Spawn an LLM agent to execute a task
 * - Deterministic steps (type: "deterministic"): Execute a shell command
 */
export interface WorkflowStep {
  /** Unique step name within the workflow. */
  name: string;
  /** Step type: "agent" (default) or "deterministic". */
  type?: WorkflowStepType;
  /** Step names that must complete before this step runs. */
  dependsOn?: string[];
  /** Timeout in milliseconds. */
  timeoutMs?: number;

  // ── Agent step fields ──────────────────────────────────────────────────────
  /** Name of the agent to execute this step (required for agent steps). */
  agent?: string;
  /** Task description for the agent (required for agent steps). */
  task?: string;
  /** Verification check to validate step output. */
  verification?: VerificationCheck;
  /** Number of retry attempts on failure. */
  retries?: number;
  /** Maximum iterations for steps that may need to retry (e.g., fix-failures). */
  maxIterations?: number;

  // ── Deterministic step fields ──────────────────────────────────────────────
  /** Shell command to execute (required for deterministic steps). */
  command?: string;
  /** Fail if command exit code is non-zero. Default: true. */
  failOnError?: boolean;
  /** Capture stdout as step output for downstream steps. Default: true. */
  captureOutput?: boolean;
}

/** Type guard: Check if a step is a deterministic (shell command) step. */
export function isDeterministicStep(step: WorkflowStep): boolean {
  return step.type === "deterministic";
}

/** Type guard: Check if a step is an agent (LLM-powered) step. */
export function isAgentStep(step: WorkflowStep): boolean {
  return step.type !== "deterministic";
}

// Legacy type aliases for backward compatibility
export type AgentWorkflowStep = WorkflowStep;
export type DeterministicWorkflowStep = WorkflowStep;

/** Verification check to validate a step's output. */
export interface VerificationCheck {
  type: "output_contains" | "exit_code" | "file_exists" | "custom";
  value: string;
  description?: string;
}

// ── Coordination ────────────────────────────────────────────────────────────

/** Coordination settings for multi-agent synchronization. */
export interface CoordinationConfig {
  barriers?: Barrier[];
  votingThreshold?: number;
  consensusStrategy?: "majority" | "unanimous" | "quorum";
}

/** A synchronization barrier that gates downstream work. */
export interface Barrier {
  name: string;
  waitFor: string[];
  timeoutMs?: number;
}

// ── State management ────────────────────────────────────────────────────────

/** Shared state configuration for workflows. */
export interface StateConfig {
  backend: "memory" | "redis" | "database";
  ttlMs?: number;
  namespace?: string;
}

// ── Error handling ──────────────────────────────────────────────────────────

/** Global error handling configuration. */
export interface ErrorHandlingConfig {
  strategy: "fail-fast" | "continue" | "retry";
  maxRetries?: number;
  retryDelayMs?: number;
  notifyChannel?: string;
}

// ── Database row types ──────────────────────────────────────────────────────

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Database row representing a workflow run. */
export interface WorkflowRunRow {
  id: string;
  workspaceId: string;
  workflowName: string;
  pattern: SwarmPattern;
  status: WorkflowRunStatus;
  config: RelayYamlConfig;
  stateSnapshot?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/** Database row representing a single workflow step execution. */
export interface WorkflowStepRow {
  id: string;
  runId: string;
  stepName: string;
  /** Agent name for agent steps, null for deterministic steps. */
  agentName: string | null;
  /** Step type: agent or deterministic. */
  stepType: WorkflowStepType;
  status: WorkflowStepStatus;
  /** Task description for agent steps, command for deterministic steps. */
  task: string;
  dependsOn: string[];
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}
