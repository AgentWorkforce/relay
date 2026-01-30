/**
 * Bridge Types
 * Types for multi-project orchestration
 */

export interface ProjectConfig {
  /** Absolute path to project root */
  path: string;
  /** Project identifier (derived from path hash) */
  id: string;
  /** Socket path for this project's daemon */
  socketPath: string;
  /** Lead agent name (auto-generated from dirname if not specified) */
  leadName: string;
  /** CLI tool to use (default: claude) */
  cli: string;
}

export interface BridgeConfig {
  /** Projects to bridge */
  projects: ProjectConfig[];
  /** CLI override for all projects */
  cliOverride?: string;
}

export interface LeadInfo {
  /** Lead agent name */
  name: string;
  /** Project this lead manages */
  projectId: string;
  /** Whether lead is currently connected */
  connected: boolean;
}

export interface SpawnRequest {
  /** Worker agent name */
  name: string;
  /** CLI tool (e.g., 'claude', 'claude:opus', 'codex') */
  cli: string;
  /** Initial task to inject */
  task: string;
  /** Optional team name to organize agents under */
  team?: string;
  /** Working directory for the agent (defaults to detected workspace) */
  cwd?: string;
  /** Name of the agent requesting the spawn (for policy enforcement) */
  spawnerName?: string;
  /** Interactive mode - disables auto-accept of permission prompts (for auth setup flows) */
  interactive?: boolean;
  /** Shadow execution mode (subagent = no extra process) */
  shadowMode?: 'subagent' | 'process';
  /** Primary agent to shadow (if this agent is a shadow) */
  shadowOf?: string;
  /** Shadow agent profile to use (for subagent mode) */
  shadowAgent?: string;
  /** When to trigger the shadow (for subagent mode) */
  shadowTriggers?: Array<'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES'>;
  /** When the shadow should speak (default: ['EXPLICIT_ASK']) */
  shadowSpeakOn?: Array<'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES'>;
  /** User ID for per-user credential storage in shared workspaces */
  userId?: string;
  /** Include ACK/DONE workflow conventions in agent instructions (default: false) */
  includeWorkflowConventions?: boolean;
}

/** Policy decision details */
export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policySource: 'repo' | 'local' | 'workspace' | 'default';
}

export interface SpawnResult {
  success: boolean;
  name: string;
  /** PID of the spawned process (for pty-based workers) */
  pid?: number;
  error?: string;
  /** Unique error ID for support lookup (e.g., ERR-1706012345-a7f3) */
  errorId?: string;
  /** Policy decision details if spawn was blocked by policy */
  policyDecision?: PolicyDecision;
}

export interface WorkerInfo {
  name: string;
  cli: string;
  task: string;
  /** Optional team name this agent belongs to */
  team?: string;
  /** Name of the agent that spawned this worker */
  spawnerName?: string;
  spawnedAt: number;
  /** PID of the pty process */
  pid?: number;
}

/** SpeakOn trigger types for shadow agents */
export type SpeakOnTrigger = 'SESSION_END' | 'CODE_WRITTEN' | 'REVIEW_REQUEST' | 'EXPLICIT_ASK' | 'ALL_MESSAGES';

/** Shadow role preset names */
export type ShadowRolePreset = 'reviewer' | 'auditor' | 'active';

/** Primary agent configuration for spawnWithShadow */
export interface PrimaryAgentConfig {
  /** Agent name */
  name: string;
  /** CLI command (default: 'claude') */
  command?: string;
  /** Initial task to send to the agent */
  task?: string;
  /** Team name to organize under */
  team?: string;
}

/** Shadow agent configuration for spawnWithShadow */
export interface ShadowAgentConfig {
  /** Shadow agent name */
  name: string;
  /** CLI command (default: same as primary) */
  command?: string;
  /** Role preset (reviewer, auditor, active) or custom prompt */
  role?: ShadowRolePreset | string;
  /** Custom speakOn triggers (overrides role preset) */
  speakOn?: SpeakOnTrigger[];
  /** Custom prompt for the shadow agent */
  prompt?: string;
}

/** Request for spawning a primary agent with its shadow */
export interface SpawnWithShadowRequest {
  /** Primary agent configuration */
  primary: PrimaryAgentConfig;
  /** Shadow agent configuration */
  shadow: ShadowAgentConfig;
}

/** Result from spawnWithShadow */
export interface SpawnWithShadowResult {
  success: boolean;
  /** Primary agent spawn result */
  primary?: SpawnResult;
  /** Shadow agent spawn result */
  shadow?: SpawnResult;
  /** Error message if overall operation failed */
  error?: string;
}
