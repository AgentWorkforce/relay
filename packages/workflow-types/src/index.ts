/**
 * Shared workflow types for Agent Relay packages.
 *
 * This package is intentionally a leaf dependency so workflow integrations can
 * share the public workflow type surface without depending on the full SDK.
 */

export type SwarmPattern =
  | 'fan-out'
  | 'pipeline'
  | 'hub-spoke'
  | 'consensus'
  | 'mesh'
  | 'handoff'
  | 'cascade'
  | 'dag'
  | 'debate'
  | 'hierarchical'
  // Additional patterns
  | 'map-reduce'
  | 'scatter-gather'
  | 'supervisor'
  | 'reflection'
  | 'red-team'
  | 'verifier'
  | 'auction'
  | 'escalation'
  | 'saga'
  | 'circuit-breaker'
  | 'blackboard'
  | 'swarm'
  | 'competitive'
  | 'review-loop';

// ── Agent definitions ───────────────────────────────────────────────────────

export type AgentPreset = 'lead' | 'worker' | 'reviewer' | 'analyst';

/** Optional credential settings for a workflow agent. */
export interface AgentCredentialConfig {
  /** Opt the agent into credential proxy mode. */
  proxy?: boolean;
  /** Override the provider used for proxy credential resolution. */
  provider?: string;
}

/** Definition of an agent participating in a workflow. */
export interface AgentDefinition {
  name: string;
  cli: AgentCli;
  role?: string;
  task?: string;
  channels?: string[];
  constraints?: AgentConstraints;
  /**
   * Permission configuration controlling file access, network, and exec restrictions.
   * Omitting this field preserves the default behavior: inherit dotfiles + readwrite access.
   */
  permissions?: AgentPermissions;
  /** When false, the agent runs as a non-interactive subprocess (no PTY, no relay messaging).
   *  It receives its task as a CLI prompt argument and returns stdout as output.
   *  Default: true (interactive PTY mode). */
  interactive?: boolean;
  /** Working directory for this agent, resolved relative to the YAML file. */
  cwd?: string;
  /** Sets this agent's working directory to a named entry from the top-level `paths` array.
   *  Mutually exclusive with `cwd`. If omitted, the agent runs in the runner's
   *  working directory (the directory containing the workflow YAML file). */
  workdir?: string;
  /** Additional paths the agent needs read/write access to. */
  additionalPaths?: string[];
  /**
   * Role preset that automatically configures interactive mode and injects
   * appropriate task guardrails. Overrides are still accepted.
   *   lead     → interactive PTY, relay-aware, coordinates workers via channels
   *   worker   → interactive: false, produces structured output, no sub-agents
   *   reviewer → interactive: false, reads artifacts, produces verdict, no sub-agents
   *   analyst  → interactive: false, reads code/files, writes findings, no sub-agents
   */
  preset?: AgentPreset;
  /** Optional credential proxy settings for this agent. */
  credentials?: AgentCredentialConfig;
  /** System prompt / skills for API-mode agents (cli: 'api'). */
  skills?: string;
}

export type AgentCli =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'aider'
  | 'goose'
  | 'opencode'
  | 'droid'
  | 'cursor'
  | 'cursor-agent'
  | 'agent'
  | 'api';

/** Resource and behavioral constraints for an agent. */
export interface AgentConstraints {
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  model?: string;
  /** Silence duration in seconds before the agent is considered idle (0 = disabled, default: 30). */
  idleThresholdSecs?: number;
}

// ── Permission types ────────────────────────────────────────────────────────

/**
 * Access preset for role-based permission shortcuts.
 *
 *   readonly    → read all non-ignored files, write nothing
 *   readwrite   → read and write all non-ignored files (default behavior)
 *   restricted  → read/write only explicitly listed paths
 *   full        → read and write everything, including normally-ignored files
 */
export type AccessPreset = 'readonly' | 'readwrite' | 'restricted' | 'full';

/** Fine-grained network permission with allowlist/denylist. */
export interface NetworkPermissions {
  /** Host:port pairs the agent may connect to (e.g. ['registry.npmjs.org:443']). */
  allow?: string[];
  /** Host:port patterns to block (e.g. ['*'] to deny all except allowed). */
  deny?: string[];
}

/** Network permission: boolean to allow/deny all, or object for fine-grained control. */
export type NetworkPermission = boolean | NetworkPermissions;

/** Glob-based file permission scopes for an agent. */
export interface FilePermissions {
  /** Glob patterns the agent may read (e.g. ['src/**', 'docs/**']). */
  read?: string[];
  /** Glob patterns the agent may write (e.g. ['src/tests/**']). */
  write?: string[];
  /** Glob patterns the agent must never access (e.g. ['.env', 'secrets/**']).
   *  Deny rules take precedence over read/write grants. */
  deny?: string[];
}

/** Reusable named permission profile shared by one or more agents. */
export interface PermissionProfileDefinition {
  /** Human-readable summary of the profile's intended use. */
  description?: string;

  /** Explain why this profile exists or what constraint it is protecting. */
  why?: string;

  /** Role-based access preset. Expands into file permission rules.
   *  Default: 'readwrite'. */
  access?: AccessPreset;

  /** Inherit patterns from .agentignore and .agentreadonly dotfiles.
   *  Default: true. Set to false to ignore dotfiles for this agent. */
  inherit?: boolean;

  /** Explicit glob-based file read/write/deny rules.
   *  Merged on top of the access preset and inherited dotfile patterns. */
  files?: FilePermissions;

  /** Raw relayauth scopes appended verbatim to the minted token.
   *  For power users who need fine-grained control beyond file globs.
   *  Example: ['relayfile:fs:read:/src/**', 'relayfile:fs:write:/tests/**'] */
  scopes?: string[];

  /** Network access control.
   *  - undefined: no restriction
   *  - false: deny all network access
   *  - { allow, deny }: fine-grained host:port allowlist/denylist */
  network?: NetworkPermission;

  /** Allowlist of shell commands the agent may execute.
   *  When set, only commands matching these prefixes are permitted.
   *  Example: ['npm test', 'npm run lint', 'git diff']
   *  Default: undefined (no restriction). */
  exec?: string[];
}

/**
 * Permission configuration for a workflow agent.
 *
 * All fields are optional — omitting `permissions` entirely preserves the
 * existing default behavior (inherit dotfiles, readwrite access).
 *
 * Resolution order (later overrides earlier):
 *   1. Dotfile patterns (.agentignore / .agentreadonly) when `inherit` is true
 *   2. `access` preset expands into base file rules
 *   3. Explicit `files` globs merge on top
 *   4. `deny` patterns always win (applied last)
 *   5. `scopes` are appended verbatim to the token
 */
export interface AgentPermissions {
  /** Human-readable summary of what this permission block is for. */
  description?: string;

  /** Reference a reusable entry from the top-level `permission_profiles` map. */
  profile?: string;

  /** Explain why these permissions are needed or intentionally constrained. */
  why?: string;

  /** Role-based access preset. Expands into file permission rules.
   *  Default: 'readwrite'. */
  access?: AccessPreset;

  /** Inherit patterns from .agentignore and .agentreadonly dotfiles.
   *  Default: true. Set to false to ignore dotfiles for this agent. */
  inherit?: boolean;

  /** Explicit glob-based file read/write/deny rules.
   *  Merged on top of the access preset and inherited dotfile patterns. */
  files?: FilePermissions;

  /** Raw relayauth scopes appended verbatim to the minted token.
   *  For power users who need fine-grained control beyond file globs.
   *  Example: ['relayfile:fs:read:/src/**', 'relayfile:fs:write:/tests/**'] */
  scopes?: string[];

  /** Network access control.
   *  - undefined: no restriction
   *  - false: deny all network access
   *  - { allow, deny }: fine-grained host:port allowlist/denylist */
  network?: NetworkPermission;

  /** Allowlist of shell commands the agent may execute.
   *  When set, only commands matching these prefixes are permitted.
   *  Example: ['npm test', 'npm run lint', 'git diff']
   *  Default: undefined (no restriction). */
  exec?: string[];
}

/** Step type: agent (LLM-powered), deterministic (shell command), worktree (git worktree setup), or integration (external service). */
export type WorkflowStepType = 'agent' | 'deterministic' | 'worktree' | 'integration';

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
  /** Reference to a custom step definition from .relay/steps.yaml. */
  use?: string;
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
  /** Explicit working directory for this step. */
  cwd?: string;

  // ── Deterministic step fields ──────────────────────────────────────────────
  /** Shell command to execute (required for deterministic steps). */
  command?: string;
  /** Sets this step's working directory to a named entry from the top-level `paths` array.
   *  If omitted, the step inherits the agent's workdir, or falls back to the runner's
   *  working directory. */
  workdir?: string;
  /** Fail if command exit code is non-zero. Default: true. */
  failOnError?: boolean;
  /** Capture stdout as step output for downstream steps. Default: true. */
  captureOutput?: boolean;

  // ── Integration step fields ────────────────────────────────────────────────
  /** Integration name: 'github', 'linear', 'slack' (required for integration steps). */
  integration?: string;
  /** Action within the integration, e.g. 'create-pr', 'create-branch' (required for integration steps). */
  action?: string;
  /** Action parameters, supports {{steps.X.output}} interpolation. */
  params?: Record<string, string>;

  // ── Worktree step fields ──────────────────────────────────────────────────
  /** Branch name for the worktree (required for worktree steps). */
  branch?: string;
  /** Base branch to create the worktree from. Default: HEAD. */
  baseBranch?: string;
  /** Explicit path for the worktree. Default: .worktrees/<step-name>. */
  path?: string;
  /** Create the branch if it doesn't exist. Default: true. */
  createBranch?: boolean;
}

/** Type guard: Check if a step is a deterministic (shell command) step. */
export function isDeterministicStep(step: WorkflowStep): boolean {
  return step.type === 'deterministic';
}

/** Type guard: Check if a step is a worktree (git worktree setup) step. */
export function isWorktreeStep(step: WorkflowStep): boolean {
  return step.type === 'worktree';
}

/** Type guard: Check if a step is an integration (external service) step. */
export function isIntegrationStep(step: WorkflowStep): boolean {
  return step.type === 'integration';
}

/** Type guard: Check if a step uses a custom step definition. */
export function isCustomStep(step: WorkflowStep): boolean {
  return step.use !== undefined;
}

/** Type guard: Check if a step is an agent (LLM-powered) step. */
export function isAgentStep(step: WorkflowStep): boolean {
  return step.type !== 'deterministic' && step.type !== 'worktree' && step.type !== 'integration';
}

// Legacy type aliases for backward compatibility
export type AgentWorkflowStep = WorkflowStep;
export type DeterministicWorkflowStep = WorkflowStep;

/** Verification check to validate a step's output. */
export interface VerificationCheck {
  type: 'output_contains' | 'exit_code' | 'file_exists' | 'custom';
  value: string;
  description?: string;
  timeoutMs?: number;
  /** Name of the agent to analyze verification failures before retrying. */
  diagnosticAgent?: string;
  /** Timeout for the diagnostic agent in milliseconds. Default: 60_000. */
  diagnosticTimeout?: number;
}

/**
 * Extension point for delegating step execution to an external backend
 * (e.g. Daytona sandboxes) while keeping the runner's DAG/retry/verification
 * machinery intact.
 */
export interface RunnerStepExecutor {
  executeAgentStep(
    step: WorkflowStep,
    agentDef: AgentDefinition,
    resolvedTask: string,
    timeoutMs?: number
  ): Promise<string>;

  executeDeterministicStep?(
    step: WorkflowStep,
    resolvedCommand: string,
    cwd: string
  ): Promise<{ output: string; exitCode: number }>;

  executeIntegrationStep?(
    step: WorkflowStep,
    resolvedParams: Record<string, string>,
    context: { workspaceId?: string }
  ): Promise<{ output: string; success: boolean }>;
}
