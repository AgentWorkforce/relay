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
  /** Reusable permission profiles that agents can reference via permissions.profile. */
  permission_profiles?: Record<string, PermissionProfileDefinition>;
  /** Named paths to external directories used by this workflow.
   *  The primary working directory defaults to cwd and does not need to be declared.
   *  Use this to declare additional directories so the runner can validate them
   *  in preflight and agents can reference them via `workdir`. */
  paths?: PathDefinition[];
  swarm: SwarmConfig;
  agents: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  coordination?: CoordinationConfig;
  state?: StateConfig;
  errorHandling?: ErrorHandlingConfig;
  trajectories?: TrajectoryConfig | false;
}

// ── Path definitions ────────────────────────────────────────────────────────

/** A named path to an external directory for cross-repo workflows.
 *  Only needed for directories outside the default working directory. */
export interface PathDefinition {
  /** Unique name used to reference this path (e.g. "relaycast"). */
  name: string;
  /** Directory path, resolved relative to the YAML file.
   *  Supports environment variables: "$HOME/.openclaw", "$RELAY_ROOT/packages/sdk". */
  path: string;
  /** Human-readable description of this path's role in the workflow. */
  description?: string;
  /** Whether this path is required. If true (default), preflight fails if it doesn't exist. */
  required?: boolean;
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

/** Provider-specific credential settings for the credential proxy. */
export interface CredentialProxyProviderConfig {
  /** Reference to the credential in the credential store. */
  credentialId: string;
  /** Optional env var name to read the provider API key from as a fallback. */
  apiKeyEnvVar?: string;
}

/** Swarm-level credential proxy configuration. */
export interface CredentialProxyConfig {
  /** Proxy endpoint URL. */
  proxyUrl: string;
  /** JWT signing secret. Defaults to env RELAY_PROXY_JWT_SECRET when omitted. */
  jwtSecret?: string;
  /** Default max-token budget per agent session. */
  defaultBudget?: number;
  /** Provider credential mappings keyed by provider name. */
  providers: Record<string, CredentialProxyProviderConfig>;
}

/** Swarm-level settings controlling the overall pattern. */
export interface SwarmConfig {
  pattern: SwarmPattern;
  maxConcurrency?: number;
  timeoutMs?: number;
  /** Max total tokens across all steps in the workflow. */
  tokenBudget?: number;
  channel?: string;
  /** Optional credential proxy configuration for agent API access. */
  credentialProxy?: CredentialProxyConfig;
  /** Idle agent detection and nudging configuration for interactive agents. */
  idleNudge?: IdleNudgeConfig;
  /**
   * Grace period (ms) after an agent exits with code 0 but without posting
   * the expected coordination signal. During this window the runner checks
   * verification gates and evidence before failing the step.
   * Default: 5000 (5 seconds). Set to 0 to disable.
   */
  completionGracePeriodMs?: number;
}

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

// ── Compiled / resolved permissions ─────────────────────────────────────────

/**
 * Fully resolved agent permissions after merging:
 *   dotfile patterns + access preset + explicit YAML file rules + custom scopes
 *
 * Produced by the permission resolver at spawn time and used to:
 *   1. Mint the agent's relayauth token (scopes)
 *   2. Configure the relayfile mount (readonlyPaths, readwritePaths, deniedPaths)
 *   3. Enforce runtime restrictions (network, exec allowlist)
 */
export interface CompiledAgentPermissions {
  /** Agent this permission set applies to. */
  agentName: string;

  /** Workspace the agent belongs to. */
  workspace: string;

  /** The effective access level after resolution. */
  effectiveAccess: AccessPreset;

  /** Whether dotfile patterns were inherited. */
  inherited: boolean;

  /** Source of each permission layer for audit/debug. */
  sources: PermissionSource[];

  // ── Resolved file paths ──────────────────────────────────────────────────

  /** Glob patterns that resolved to read-only access. */
  readonlyPatterns: string[];

  /** Glob patterns that resolved to read-write access. */
  readwritePatterns: string[];

  /** Glob patterns explicitly denied (no access). */
  deniedPatterns: string[];

  /** Concrete file paths with read-only access (after walking the project). */
  readonlyPaths: string[];

  /** Concrete file paths with read-write access (after walking the project). */
  readwritePaths: string[];

  /** Concrete file paths denied to the agent. */
  deniedPaths: string[];

  // ── Token scopes ─────────────────────────────────────────────────────────

  /** Merged relayauth scopes for the agent's token.
   *  Combines auto-generated file scopes + explicit custom scopes. */
  scopes: string[];

  // ── Runtime restrictions ─────────────────────────────────────────────────

  /** Network access control. Undefined means unrestricted. */
  network?: NetworkPermission;

  /** Allowed exec command prefixes. Undefined means unrestricted. */
  exec?: string[];

  // ── ACL (for relayfile mount) ────────────────────────────────────────────

  /** Directory-level ACL rules for the relayfile mount.
   *  Keys are normalized directory paths, values are rule arrays. */
  acl: Record<string, string[]>;

  /** Summary counts for quick inspection. */
  summary: {
    readonly: number;
    readwrite: number;
    denied: number;
    customScopes: number;
  };
}

/** Identifies where a permission rule originated. */
export interface PermissionSource {
  /** Source type. */
  type: 'dotfile' | 'preset' | 'yaml' | 'scope';
  /** Human-readable description (e.g. '.agentignore', 'access: readonly'). */
  label: string;
  /** Number of rules contributed by this source. */
  ruleCount: number;
}

// ── Type guards ─────────────────────────────────────────────────────────────

/**
 * Returns true if the agent has restricted permissions —
 * i.e., it has explicit permissions set AND those permissions limit access
 * beyond the default readwrite+inherit behavior.
 *
 * An agent is considered restricted if any of the following are true:
 *   - access is 'readonly' or 'restricted'
 *   - files.deny has entries
 *   - network is false or an allowlist/denylist object
 *   - exec allowlist is set (any commands at all = restricted execution)
 *   - inherit is explicitly false (opts out of dotfile protections)
 */
export function isRestrictedAgent(agent: AgentDefinition): boolean {
  const perms = agent.permissions;
  if (!perms) return false;

  if (perms.access === 'readonly' || perms.access === 'restricted') return true;
  if (perms.files?.deny && perms.files.deny.length > 0) return true;
  if (perms.network === false || (typeof perms.network === 'object' && perms.network !== null)) return true;
  if (perms.exec && perms.exec.length > 0) return true;
  if (perms.inherit === false) return true;

  return false;
}

// ── Workflow definitions ────────────────────────────────────────────────────

/** Preflight check that runs before any workflow steps. */
export interface PreflightCheck {
  /** Shell command to execute. */
  command: string;
  /** Fail if output matches this condition: "non-empty", "empty", or a regex pattern. */
  failIf?: 'non-empty' | 'empty' | string;
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
  onError?: 'fail' | 'skip' | 'retry';
}

/** Step type: agent (LLM-powered), deterministic (shell command), worktree (git worktree setup), or integration (external service). */
export type WorkflowStepType = 'agent' | 'deterministic' | 'worktree' | 'integration';

// ── Custom step definitions ─────────────────────────────────────────────────

/** Parameter definition for a custom step. */
export interface CustomStepParam {
  /** Parameter name. */
  name: string;
  /** Whether this parameter is required. Default: false. */
  required?: boolean;
  /** Default value if not provided. */
  default?: string;
  /** Human-readable description of the parameter. */
  description?: string;
}

/** A reusable custom step definition stored in .relay/steps.yaml. */
export interface CustomStepDefinition {
  /** Parameters that can be passed when using this step. */
  params?: CustomStepParam[];
  /** Step type: "deterministic" or "worktree". */
  type?: 'deterministic' | 'worktree';
  /** Shell command to execute (for deterministic steps). Supports {{param}} interpolation. */
  command?: string;
  /** Branch name (for worktree steps). Supports {{param}} interpolation. */
  branch?: string;
  /** Base branch (for worktree steps). */
  baseBranch?: string;
  /** Worktree path (for worktree steps). */
  path?: string;
  /** Create branch if missing (for worktree steps). */
  createBranch?: boolean;
  /** Fail if command exit code is non-zero. Default: true. */
  failOnError?: boolean;
  /** Capture stdout as step output. Default: true. */
  captureOutput?: boolean;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Human-readable description of this step. */
  description?: string;
}

/** Configuration file for custom step definitions (.relay/steps.yaml). */
export interface CustomStepsConfig {
  /** Map of step name to step definition. */
  steps: Record<string, CustomStepDefinition>;
}

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

/** Diagnostic output captured after a verification failure analysis run. */
export interface DiagnosticResult {
  agentName: string;
  analysis: string;
  durationMs: number;
  tokens?: {
    input: number;
    output: number;
  };
}

// ── Completion evidence ─────────────────────────────────────────────────────

export type CompletionEvidenceSignalSource =
  | 'channel'
  | 'stdout'
  | 'stderr'
  | 'process'
  | 'filesystem'
  | 'tool'
  | 'verification';

export type CompletionEvidenceSignalKind =
  | 'worker_done'
  | 'lead_done'
  | 'step_complete'
  | 'owner_decision'
  | 'review_decision'
  | 'task_summary'
  | 'verification_passed'
  | 'verification_failed'
  | 'process_exit'
  | 'custom';

export interface CompletionEvidenceSignal {
  kind: CompletionEvidenceSignalKind;
  source: CompletionEvidenceSignalSource;
  text: string;
  observedAt: string;
  sender?: string;
  actor?: string;
  role?: string;
  value?: string;
}

export type CompletionEvidenceChannelOrigin = 'runner_post' | 'forwarded_chunk' | 'relay_message';

export interface CompletionEvidenceChannelPost {
  stepName: string;
  text: string;
  postedAt: string;
  origin: CompletionEvidenceChannelOrigin;
  completionRelevant: boolean;
  sender?: string;
  actor?: string;
  role?: string;
  target?: string;
  signals: CompletionEvidenceSignal[];
}

export type CompletionEvidenceFileChangeKind = 'created' | 'modified' | 'deleted';

export interface CompletionEvidenceFileChange {
  path: string;
  kind: CompletionEvidenceFileChangeKind;
  observedAt: string;
  root?: string;
}

export type CompletionEvidenceToolSideEffectType =
  | 'persist_step_output'
  | 'post_channel_message'
  | 'verification_observed'
  | 'worktree_created'
  | 'owner_monitoring'
  | 'review_started'
  | 'review_completed'
  | 'worker_exit'
  | 'worker_error'
  | 'retry'
  | 'custom';

export interface CompletionEvidenceToolSideEffect {
  type: CompletionEvidenceToolSideEffectType;
  detail: string;
  observedAt: string;
  raw?: Record<string, unknown>;
}

export interface StepCompletionEvidence {
  stepName: string;
  status?: WorkflowStepStatus;
  startedAt?: string;
  completedAt?: string;
  lastUpdatedAt: string;
  roots: string[];
  output: {
    stdout: string;
    stderr: string;
    combined: string;
  };
  channelPosts: CompletionEvidenceChannelPost[];
  files: CompletionEvidenceFileChange[];
  process: {
    exitCode?: number;
    exitSignal?: string;
  };
  toolSideEffects: CompletionEvidenceToolSideEffect[];
  coordinationSignals: CompletionEvidenceSignal[];
}

export type StepCompletionMode =
  | 'marker'
  | 'evidence'
  | 'verification'
  | 'owner_decision'
  | 'review'
  | 'heuristic';

export interface StepCompletionDecisionEvidence {
  summary?: string;
  signals?: string[];
  channelPosts?: string[];
  files?: string[];
  exitCode?: number;
}

export interface StepCompletionDecision {
  mode: StepCompletionMode;
  reason?: string;
  evidence?: StepCompletionDecisionEvidence;
}

// ── Coordination ────────────────────────────────────────────────────────────

/** Coordination settings for multi-agent synchronization. */
export interface CoordinationConfig {
  barriers?: Barrier[];
  votingThreshold?: number;
  consensusStrategy?: 'majority' | 'unanimous' | 'quorum';
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
  backend: 'memory' | 'redis' | 'database';
  ttlMs?: number;
  namespace?: string;
}

// ── Error handling ──────────────────────────────────────────────────────────

/** Global error handling configuration. */
export interface ErrorHandlingConfig {
  strategy: 'fail-fast' | 'continue' | 'retry';
  maxRetries?: number;
  retryDelayMs?: number;
  notifyChannel?: string;
}

// ── Dry-run report types ────────────────────────────────────────────────

/** A single execution wave in a dry-run simulation. */
export interface DryRunWave {
  wave: number;
  /** Steps in this wave. Agent is undefined for deterministic steps. */
  steps: Array<{ name: string; agent?: string; dependsOn: string[] }>;
}

/** Report produced by a dry-run validation of a workflow config. */
export interface DryRunReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  name: string;
  description?: string;
  pattern: string;
  agents: Array<{ name: string; cli: string; role?: string; cwd?: string; stepCount: number }>;
  permissions?: Array<{
    agent: string;
    access: string;
    readPaths: number;
    writePaths: number;
    denyPaths: number;
    scopes: number;
    source: 'yaml' | 'preset' | 'dotfiles' | 'none';
  }>;
  waves: DryRunWave[];
  totalSteps: number;
  maxConcurrency?: number;
  estimatedWaves: number;
  /** Estimated peak concurrent agents. */
  estimatedPeakConcurrency?: number;
  /** Estimated total agent-steps (counting retries as additional steps). */
  estimatedTotalAgentSteps?: number;
}

// ── Workflow execution options ───────────────────────────────────────────────

/** Options that control how a workflow run executes. */
export interface WorkflowExecuteOptions {
  /** Start execution from a specific step, skipping all predecessor steps.
   *  Predecessor outputs are loaded from cached step-outputs on disk when available. */
  startFrom?: string;
  /** Run ID of a previous execution whose cached step outputs should be used
   *  when skipping predecessor steps via `startFrom`. If omitted, the runner
   *  scans `.agent-relay/step-outputs/` for the most recent directory that
   *  contains the needed step files. */
  previousRunId?: string;
}

// ── Database row types ──────────────────────────────────────────────────────

export type WorkflowRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

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

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type WorkflowOwnerDecision =
  | 'COMPLETE'
  | 'INCOMPLETE_RETRY'
  | 'INCOMPLETE_FAIL'
  | 'NEEDS_CLARIFICATION';
/**
 * Completion reasons are recorded for both successful and failed steps.
 * `retry_requested_by_owner` is a retry-control signal, not a success state:
 * the runner retries while budget remains and fails the step once retries are exhausted.
 */
export type WorkflowStepCompletionReason =
  | 'completed_verified'
  | 'completed_by_owner_decision'
  | 'completed_by_evidence'
  | 'completed_by_process_exit'
  | 'retry_requested_by_owner'
  | 'failed_verification'
  | 'failed_verification_with_diagnostic'
  | 'failed_owner_decision'
  | 'failed_no_evidence';

/** Database row representing a single workflow step execution. */
export interface WorkflowStepRow {
  id: string;
  runId: string;
  stepName: string;
  /** Agent name for agent steps, null for deterministic/worktree steps. */
  agentName: string | null;
  /** Step type: agent, deterministic, or worktree. */
  stepType: WorkflowStepType;
  status: WorkflowStepStatus;
  /** Task description for agent steps, command for deterministic steps, branch for worktree steps. */
  task: string;
  dependsOn: string[];
  output?: string;
  error?: string;
  completionReason?: WorkflowStepCompletionReason;
  startedAt?: string;
  completedAt?: string;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
}
