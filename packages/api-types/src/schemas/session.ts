/**
 * Session Schemas
 *
 * Zod schemas for session-related types used across the dashboard and API.
 */

import { z } from 'zod';

/**
 * Session closed by enum
 */
export const SessionClosedBySchema = z.enum(['agent', 'disconnect', 'error']);
export type SessionClosedBy = z.infer<typeof SessionClosedBySchema>;

/**
 * Session schema - represents an agent session
 */
export const SessionSchema = z.object({
  /** Unique session ID */
  id: z.string(),
  /** Agent name for this session */
  agentName: z.string(),
  /** CLI type used (claude, codex, gemini, etc.) */
  cli: z.string().optional(),
  /** Session start timestamp (ISO string) */
  startedAt: z.string(),
  /** Session end timestamp (ISO string) */
  endedAt: z.string().optional(),
  /** Human-readable duration string */
  duration: z.string().optional(),
  /** Total messages in session */
  messageCount: z.number(),
  /** Session summary text */
  summary: z.string().optional(),
  /** Whether session is currently active */
  isActive: z.boolean(),
  /** How the session was closed */
  closedBy: SessionClosedBySchema.optional(),
});
export type Session = z.infer<typeof SessionSchema>;
