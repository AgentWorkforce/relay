/**
 * Continuity System Types
 *
 * Core types for the CLI-agnostic session continuity system.
 * Works with any CLI (Claude, Codex, Gemini, custom) via output
 * pattern detection and PTY injection.
 */

import type { PDEROPhase } from '../trajectory/integration.js';

/**
 * A decision recorded during agent work
 */
export interface Decision {
  /** The choice that was made */
  decision: string;
  /** Why this choice was made */
  reasoning?: string;
  /** Alternative options considered */
  alternatives?: string[];
  /** Confidence level (0-1) */
  confidence?: number;
  /** When the decision was made */
  timestamp: Date;
}

/**
 * A file reference with optional line numbers
 */
export interface FileRef {
  /** Relative or absolute path */
  path: string;
  /** Line range [start, end] */
  lines?: [number, number];
  /** Brief description of what's relevant */
  description?: string;
}

/**
 * Ledger - Within-session state snapshot
 *
 * Ephemeral, overwritten each session. Captures current work state
 * for context injection on restart/clear.
 */
export interface Ledger {
  /** Agent name this ledger belongs to */
  agentName: string;
  /** Unique agent instance ID (persists across restarts for resume) */
  agentId: string;
  /** Unique session identifier */
  sessionId: string;
  /** CLI being used (claude, codex, gemini, custom) */
  cli: string;

  // Current state
  /** What the agent is currently working on */
  currentTask: string;
  /** Completed work items */
  completed: string[];
  /** Work in progress */
  inProgress: string[];
  /** Blocked items with reasons */
  blocked: string[];

  // Decisions & Context
  /** Key decisions made during session */
  keyDecisions: Decision[];
  /** Items marked as uncertain (need verification) */
  uncertainItems: string[];
  /** Recently touched files */
  fileContext: FileRef[];

  // Trajectory integration (optional)
  /** Active trajectory ID if using trail */
  trajectoryId?: string;
  /** Current PDERO phase */
  pderoPhase?: PDEROPhase;

  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * Handoff - Cross-session transfer document
 *
 * Permanent, searchable. Created on trajectory completion,
 * context limit, crash, or manual save.
 */
export interface Handoff {
  /** Unique handoff identifier */
  id: string;
  /** Agent that created this handoff */
  agentName: string;
  /** Agent instance ID that created this handoff */
  agentId?: string;
  /** CLI used (for context) */
  cli: string;

  // Content
  /** Brief summary of the handoff */
  summary: string;
  /** Task being worked on */
  taskDescription: string;
  /** Work completed before handoff */
  completedWork: string[];
  /** Recommended next steps */
  nextSteps: string[];

  // References
  /** Files relevant to the work */
  fileReferences: FileRef[];
  /** Key decisions made */
  decisions: Decision[];
  /** Links to related previous handoffs */
  relatedHandoffs: string[];

  // Metadata
  /** When the handoff was created */
  createdAt: Date;
  /** What triggered the handoff */
  triggerReason: HandoffTrigger;

  // Trajectory integration (optional)
  /** Trajectory ID if created from trajectory completion */
  trajectoryId?: string;
  /** PDERO phase at handoff time */
  pderoPhase?: PDEROPhase;
  /** Confidence level from trajectory */
  confidence?: number;
  /** Learnings extracted from trajectory */
  learnings?: string[];
}

/**
 * What triggered handoff creation
 */
export type HandoffTrigger =
  | 'manual'            // User/agent explicitly saved
  | 'trajectory_complete'  // Trail completed
  | 'context_limit'     // Context approaching limit
  | 'auto_restart'      // Agent restarting
  | 'crash'             // Agent crashed
  | 'session_end';      // Session ending normally

/**
 * Continuity command parsed from agent output
 */
export interface ContinuityCommand {
  /** Command type */
  type: 'save' | 'load' | 'search' | 'uncertain' | 'handoff';
  /** Content for save commands */
  content?: string;
  /** Query for search commands */
  query?: string;
  /** Item for uncertain command */
  item?: string;
  /** Whether to create a handoff (for save) */
  createHandoff?: boolean;
}

/**
 * Context to inject on agent startup
 */
export interface StartupContext {
  /** The ledger if available */
  ledger?: Ledger;
  /** The most recent handoff if available */
  handoff?: Handoff;
  /** Relevant learnings from past sessions */
  learnings?: string[];
  /** Formatted markdown to inject */
  formatted: string;
}

/**
 * Continuity storage paths
 */
export interface ContinuityPaths {
  /** Base continuity directory */
  base: string;
  /** Ledgers directory */
  ledgers: string;
  /** Handoffs directory */
  handoffs: string;
  /** Artifact index database */
  artifactDb: string;
}

/**
 * Options for saving a ledger
 */
export interface SaveLedgerOptions {
  /** Create a handoff as well */
  createHandoff?: boolean;
  /** Trigger reason if creating handoff */
  triggerReason?: HandoffTrigger;
}

/**
 * Options for searching handoffs
 */
export interface SearchOptions {
  /** Filter by agent name */
  agentName?: string;
  /** Maximum results to return */
  limit?: number;
  /** Filter by date range */
  since?: Date;
  /** Filter by trigger reason */
  triggerReason?: HandoffTrigger;
}
