/**
 * Agent Schemas
 *
 * Zod schemas for agent-related types used across the dashboard and API.
 */

import { z } from 'zod';

/**
 * Agent status enum
 */
export const AgentStatusSchema = z.enum(['online', 'idle', 'busy', 'offline']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * Agent profile information - helps users understand agent behavior
 */
export const AgentProfileSchema = z.object({
  /** Display title/role (e.g., "Lead Developer", "Code Reviewer") */
  title: z.string().optional(),
  /** Short description of what this agent does */
  description: z.string().optional(),
  /** The prompt/task the agent was spawned with */
  spawnPrompt: z.string().optional(),
  /** Agent profile/persona prompt (e.g., lead agent instructions) */
  personaPrompt: z.string().optional(),
  /** Name of the persona preset used (e.g., "lead", "reviewer", "shadow-auditor") */
  personaName: z.string().optional(),
  /** Model being used (e.g., "claude-3-opus", "gpt-4") */
  model: z.string().optional(),
  /** Working directory */
  workingDirectory: z.string().optional(),
  /** When the agent was first seen */
  firstSeen: z.string().optional(),
  /** Capabilities or tools available to the agent */
  capabilities: z.array(z.string()).optional(),
  /** Tags for categorization */
  tags: z.array(z.string()).optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

/**
 * Agent schema - represents a connected agent
 */
export const AgentSchema = z.object({
  /** Agent name (required) */
  name: z.string(),
  /** Agent role description */
  role: z.string().optional(),
  /** CLI type used by the agent (claude, codex, gemini, etc.) */
  cli: z.string().optional(),
  /** Current agent status (required) */
  status: AgentStatusSchema,
  /** Last seen timestamp (ISO string) */
  lastSeen: z.string().optional(),
  /** Last active timestamp (ISO string) */
  lastActive: z.string().optional(),
  /** Total message count */
  messageCount: z.number().optional(),
  /** Whether the agent needs attention */
  needsAttention: z.boolean().optional(),
  /** Current task description */
  currentTask: z.string().optional(),
  /** Server the agent is connected to (for fleet view) */
  server: z.string().optional(),
  /** Whether agent is currently processing */
  isProcessing: z.boolean().optional(),
  /** Timestamp when processing started */
  processingStartedAt: z.number().optional(),
  /** Whether agent was spawned via dashboard */
  isSpawned: z.boolean().optional(),
  /** Optional team grouping */
  team: z.string().optional(),
  /** Unique agent ID for resume functionality */
  agentId: z.string().optional(),
  /** Timestamp when agent last received a message */
  lastMessageReceivedAt: z.number().optional(),
  /** Timestamp when agent last produced output */
  lastOutputAt: z.number().optional(),
  /** Whether agent is stuck */
  isStuck: z.boolean().optional(),
  /** Whether this is a human user */
  isHuman: z.boolean().optional(),
  /** Avatar URL for human users */
  avatarUrl: z.string().optional(),
  /** Whether agent's authentication has been revoked */
  authRevoked: z.boolean().optional(),
  /** Whether agent is from a linked local daemon */
  isLocal: z.boolean().optional(),
  /** Name of the linked daemon */
  daemonName: z.string().optional(),
  /** Machine ID of the linked daemon */
  machineId: z.string().optional(),
  /** Agent profile information */
  profile: AgentProfileSchema.optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

/**
 * Agent summary - condensed agent information
 */
export const AgentSummarySchema = z.object({
  agentName: z.string(),
  lastUpdated: z.string(),
  currentTask: z.string().optional(),
  completedTasks: z.array(z.string()).optional(),
  context: z.string().optional(),
  files: z.array(z.string()).optional(),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;
