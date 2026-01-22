/**
 * Spawner Types
 *
 * Zod schemas for agent spawning and lifecycle management types.
 * These types are used across the spawner, daemon, and dashboard.
 */

import { z } from 'zod';

// =============================================================================
// Enums and Basic Types
// =============================================================================

/**
 * When shadow agents should activate
 */
export const SpeakOnTriggerSchema = z.enum([
  'SESSION_END',
  'CODE_WRITTEN',
  'REVIEW_REQUEST',
  'EXPLICIT_ASK',
  'ALL_MESSAGES',
]);
export type SpeakOnTrigger = z.infer<typeof SpeakOnTriggerSchema>;

/**
 * Shadow role preset names
 */
export const ShadowRolePresetSchema = z.enum(['reviewer', 'auditor', 'active']);
export type ShadowRolePreset = z.infer<typeof ShadowRolePresetSchema>;

/**
 * Shadow execution mode
 */
export const ShadowModeSchema = z.enum(['subagent', 'process']);
export type ShadowMode = z.infer<typeof ShadowModeSchema>;

/**
 * Policy source types
 */
export const PolicySourceSchema = z.enum(['repo', 'local', 'workspace', 'default']);
export type PolicySource = z.infer<typeof PolicySourceSchema>;

// =============================================================================
// Policy Types
// =============================================================================

/**
 * Policy decision result
 */
export const PolicyDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  policySource: PolicySourceSchema,
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// =============================================================================
// Spawn Request/Result Types
// =============================================================================

/**
 * Request to spawn a new agent
 */
export const SpawnRequestSchema = z.object({
  /** Worker agent name (must be unique) */
  name: z.string(),
  /** CLI tool (e.g., 'claude', 'claude:opus', 'codex', 'gemini') */
  cli: z.string(),
  /** Initial task to inject after spawn */
  task: z.string(),
  /** Optional team name for organization */
  team: z.string().optional(),
  /** Working directory (defaults to project root) */
  cwd: z.string().optional(),
  /** Name of requesting agent (for policy enforcement) */
  spawnerName: z.string().optional(),
  /** Interactive mode - disables auto-accept of permission prompts */
  interactive: z.boolean().optional(),
  /** Shadow execution mode (subagent = no extra process) */
  shadowMode: ShadowModeSchema.optional(),
  /** Primary agent to shadow (if this agent is a shadow) */
  shadowOf: z.string().optional(),
  /** Shadow agent profile to use (for subagent mode) */
  shadowAgent: z.string().optional(),
  /** When to trigger the shadow (for subagent mode) */
  shadowTriggers: z.array(SpeakOnTriggerSchema).optional(),
  /** When the shadow should speak (default: ['EXPLICIT_ASK']) */
  shadowSpeakOn: z.array(SpeakOnTriggerSchema).optional(),
  /** User ID for per-user credential storage in shared workspaces */
  userId: z.string().optional(),
});
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/**
 * Result of a spawn operation
 */
export const SpawnResultSchema = z.object({
  success: z.boolean(),
  name: z.string(),
  /** PID of the spawned process (for pty-based workers) */
  pid: z.number().optional(),
  error: z.string().optional(),
  /** Policy decision details if spawn was blocked by policy */
  policyDecision: PolicyDecisionSchema.optional(),
});
export type SpawnResult = z.infer<typeof SpawnResultSchema>;

/**
 * Information about an active worker
 */
export const WorkerInfoSchema = z.object({
  name: z.string(),
  cli: z.string(),
  task: z.string(),
  /** Optional team name this agent belongs to */
  team: z.string().optional(),
  spawnedAt: z.number(),
  /** PID of the pty process */
  pid: z.number().optional(),
});
export type WorkerInfo = z.infer<typeof WorkerInfoSchema>;

// =============================================================================
// Shadow Agent Types
// =============================================================================

/**
 * Primary agent configuration for spawnWithShadow
 */
export const PrimaryAgentConfigSchema = z.object({
  /** Agent name */
  name: z.string(),
  /** CLI command (default: 'claude') */
  command: z.string().optional(),
  /** Initial task to send to the agent */
  task: z.string().optional(),
  /** Team name to organize under */
  team: z.string().optional(),
});
export type PrimaryAgentConfig = z.infer<typeof PrimaryAgentConfigSchema>;

/**
 * Shadow agent configuration for spawnWithShadow
 */
export const ShadowAgentConfigSchema = z.object({
  /** Shadow agent name */
  name: z.string(),
  /** CLI command (default: same as primary) */
  command: z.string().optional(),
  /** Role preset (reviewer, auditor, active) or custom prompt */
  role: z.string().optional(),
  /** Custom speakOn triggers (overrides role preset) */
  speakOn: z.array(SpeakOnTriggerSchema).optional(),
  /** Custom prompt for the shadow agent */
  prompt: z.string().optional(),
});
export type ShadowAgentConfig = z.infer<typeof ShadowAgentConfigSchema>;

/**
 * Request for spawning a primary agent with its shadow
 */
export const SpawnWithShadowRequestSchema = z.object({
  /** Primary agent configuration */
  primary: PrimaryAgentConfigSchema,
  /** Shadow agent configuration */
  shadow: ShadowAgentConfigSchema,
});
export type SpawnWithShadowRequest = z.infer<typeof SpawnWithShadowRequestSchema>;

/**
 * Result from spawnWithShadow
 */
export const SpawnWithShadowResultSchema = z.object({
  success: z.boolean(),
  /** Primary agent spawn result */
  primary: SpawnResultSchema.optional(),
  /** Shadow agent spawn result */
  shadow: SpawnResultSchema.optional(),
  /** Error message if overall operation failed */
  error: z.string().optional(),
});
export type SpawnWithShadowResult = z.infer<typeof SpawnWithShadowResultSchema>;

// =============================================================================
// Bridge/Multi-Project Types
// =============================================================================

/**
 * Project configuration for multi-project orchestration
 */
export const ProjectConfigSchema = z.object({
  /** Absolute path to project root */
  path: z.string(),
  /** Project identifier (derived from path hash) */
  id: z.string(),
  /** Socket path for this project's daemon */
  socketPath: z.string(),
  /** Lead agent name (auto-generated from dirname if not specified) */
  leadName: z.string(),
  /** CLI tool to use (default: claude) */
  cli: z.string(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Bridge configuration for multi-project coordination
 */
export const BridgeConfigSchema = z.object({
  /** Projects to bridge */
  projects: z.array(ProjectConfigSchema),
  /** CLI override for all projects */
  cliOverride: z.string().optional(),
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

/**
 * Lead agent information
 */
export const LeadInfoSchema = z.object({
  /** Lead agent name */
  name: z.string(),
  /** Project this lead manages */
  projectId: z.string(),
  /** Whether lead is currently connected */
  connected: z.boolean(),
});
export type LeadInfo = z.infer<typeof LeadInfoSchema>;
