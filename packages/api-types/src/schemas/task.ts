/**
 * Task Schemas
 *
 * Zod schemas for task-related types used across the dashboard and API.
 */

import { z } from 'zod';

/**
 * Task status enum
 */
export const TaskStatusSchema = z.enum(['open', 'in_progress', 'completed', 'blocked']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Task priority enum
 */
export const TaskPrioritySchema = z.enum(['P1', 'P2', 'P3', 'P4']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * Task type enum
 */
export const TaskTypeSchema = z.enum(['task', 'bug', 'feature', 'epic']);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/**
 * Task schema (Beads Integration)
 */
export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: TaskStatusSchema,
  priority: TaskPrioritySchema,
  type: TaskTypeSchema,
  assignee: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  blocking: z.array(z.string()).optional(),
  created: z.string(),
  updated: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * Task assignment status enum (for API)
 */
export const TaskAssignmentStatusSchema = z.enum([
  'pending',
  'assigned',
  'in_progress',
  'completed',
  'failed',
]);
export type TaskAssignmentStatus = z.infer<typeof TaskAssignmentStatusSchema>;

/**
 * Task assignment priority enum (for API)
 */
export const TaskAssignmentPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type TaskAssignmentPriority = z.infer<typeof TaskAssignmentPrioritySchema>;

/**
 * Task assignment schema (for /api/tasks endpoints)
 */
export const TaskAssignmentSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  title: z.string(),
  description: z.string(),
  priority: TaskAssignmentPrioritySchema,
  status: TaskAssignmentStatusSchema,
  createdAt: z.string(),
  assignedAt: z.string().optional(),
  completedAt: z.string().optional(),
  result: z.string().optional(),
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;
