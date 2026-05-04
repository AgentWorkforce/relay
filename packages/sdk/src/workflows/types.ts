/**
 * Workflow Types for Relay Cloud Swarm Patterns
 *
 * Shared TypeScript types for relay.yaml configuration, workflow execution,
 * and database row representations.
 */

export * from '@agent-relay/workflow-types';
export type {
  AccessPreset,
  AgentCli,
  AgentDefinition,
  AgentPermissions,
  AgentPreset,
  NetworkPermission,
  PermissionProfileDefinition,
  RunnerStepExecutor,
  SwarmPattern,
  VerificationCheck,
  WorkflowStep,
  WorkflowStepType,
} from '@agent-relay/workflow-types';

import type {
  AccessPreset,
  AgentDefinition,
  AgentPermissions,
  NetworkPermission,
  PermissionProfileDefinition,
  SwarmPattern,
  WorkflowStep,
  WorkflowStepType,
} from '@agent-relay/workflow-types';

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

// ── ProcessBackend: cloud-injected execution environment ─────────────────────
//
// Relay owns command construction, auth env, cwd, timeout, and step lifecycle.
// The backend owns execution environments (create VM, run command, destroy VM).
// uploadFile is reserved for future file asset staging; current executors run
// commands directly with env/cwd/timeout passed through exec options.

/** Backend for creating isolated execution environments (e.g. Daytona sandboxes). */
export interface ProcessBackend {
  /** Create an isolated execution environment. */
  createEnvironment(label: string): Promise<ProcessEnvironment>;
}

/** An isolated execution environment provisioned by a ProcessBackend. */
export interface ProcessEnvironment {
  /** Unique identifier for this environment. */
  id: string;
  /** Home directory inside the environment. */
  homeDir: string;
  /** Execute a shell command in the environment. */
  exec(
    command: string,
    opts?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }
  ): Promise<{ output: string; exitCode: number }>;
  /** Upload a file into the environment. */
  uploadFile(content: string | Buffer, remotePath: string): Promise<void>;
  /** Tear down the environment and release resources. */
  destroy(): Promise<void>;
}
