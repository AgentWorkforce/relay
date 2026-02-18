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
}

// ── Swarm configuration ─────────────────────────────────────────────────────

/** Swarm-level settings controlling the overall pattern. */
export interface SwarmConfig {
  pattern: SwarmPattern;
  maxConcurrency?: number;
  timeoutMs?: number;
  channel?: string;
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
  | "hierarchical";

// ── Agent definitions ───────────────────────────────────────────────────────

/** Definition of an agent participating in a workflow. */
export interface AgentDefinition {
  name: string;
  cli: AgentCli;
  role?: string;
  task?: string;
  channels?: string[];
  constraints?: AgentConstraints;
}

export type AgentCli = "claude" | "codex" | "gemini" | "aider" | "goose";

/** Resource and behavioral constraints for an agent. */
export interface AgentConstraints {
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  model?: string;
}

// ── Workflow definitions ────────────────────────────────────────────────────

/** A named workflow composed of sequential or parallel steps. */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  onError?: "fail" | "skip" | "retry";
}

/** A single step within a workflow. */
export interface WorkflowStep {
  name: string;
  agent: string;
  task: string;
  dependsOn?: string[];
  verification?: VerificationCheck;
  timeoutMs?: number;
  retries?: number;
}

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
  agentName: string;
  status: WorkflowStepStatus;
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
