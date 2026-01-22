/**
 * Decision Schemas
 *
 * Zod schemas for decision queue types used across the dashboard and API.
 */

import { z } from 'zod';

/**
 * Decision urgency/priority enum
 */
export const DecisionUrgencySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type DecisionUrgency = z.infer<typeof DecisionUrgencySchema>;

/**
 * Decision category enum
 */
export const DecisionCategorySchema = z.enum(['approval', 'choice', 'input', 'confirmation']);
export type DecisionCategory = z.infer<typeof DecisionCategorySchema>;

/**
 * Decision option schema
 */
export const DecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/**
 * API Decision schema (from API response)
 */
export const ApiDecisionSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  title: z.string(),
  description: z.string(),
  options: z.array(DecisionOptionSchema).optional(),
  urgency: DecisionUrgencySchema,
  category: DecisionCategorySchema,
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  context: z.record(z.unknown()).optional(),
});
export type ApiDecision = z.infer<typeof ApiDecisionSchema>;

/**
 * Decision schema (component format)
 */
export const DecisionSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  timestamp: z.union([z.string(), z.number()]),
  type: DecisionCategorySchema,
  title: z.string(),
  description: z.string(),
  options: z.array(DecisionOptionSchema).optional(),
  priority: DecisionUrgencySchema,
  context: z.record(z.unknown()).optional(),
  expiresAt: z.union([z.string(), z.number()]).optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * Pending decision schema (simplified format)
 */
export const PendingDecisionSchema = z.object({
  id: z.string(),
  agent: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
  context: z.string().optional(),
  priority: DecisionUrgencySchema,
  createdAt: z.string(),
  expiresAt: z.string().optional(),
});
export type PendingDecision = z.infer<typeof PendingDecisionSchema>;

/**
 * Trajectory decision type enum (for tracking)
 */
export const TrajectoryDecisionTypeSchema = z.enum([
  'tool_call',
  'message',
  'file_edit',
  'command',
  'question',
]);
export type TrajectoryDecisionType = z.infer<typeof TrajectoryDecisionTypeSchema>;

/**
 * Trajectory decision outcome enum
 */
export const TrajectoryDecisionOutcomeSchema = z.enum(['success', 'error', 'pending']);
export type TrajectoryDecisionOutcome = z.infer<typeof TrajectoryDecisionOutcomeSchema>;

/**
 * Trajectory decision schema (for decision tracking)
 */
export const TrajectoryDecisionSchema: z.ZodType<TrajectoryDecision> = z.lazy(() =>
  z.object({
    id: z.string(),
    timestamp: z.string(),
    agent: z.string(),
    type: TrajectoryDecisionTypeSchema,
    summary: z.string(),
    details: z.string().optional(),
    context: z.string().optional(),
    outcome: TrajectoryDecisionOutcomeSchema.optional(),
    children: z.array(TrajectoryDecisionSchema).optional(),
  })
);
export type TrajectoryDecision = {
  id: string;
  timestamp: string;
  agent: string;
  type: TrajectoryDecisionType;
  summary: string;
  details?: string;
  context?: string;
  outcome?: TrajectoryDecisionOutcome;
  children?: TrajectoryDecision[];
};

/**
 * Trajectory schema
 */
export const TrajectorySchema = z.object({
  agentName: z.string(),
  sessionId: z.string(),
  decisions: z.array(TrajectoryDecisionSchema),
  startTime: z.string(),
  endTime: z.string().optional(),
});
export type Trajectory = z.infer<typeof TrajectorySchema>;
