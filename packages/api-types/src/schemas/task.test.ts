/**
 * Task Schema Tests
 */

import { describe, it, expect } from 'vitest';
import {
  TaskStatusSchema,
  TaskPrioritySchema,
  TaskTypeSchema,
  TaskSchema,
  TaskAssignmentStatusSchema,
  TaskAssignmentPrioritySchema,
  TaskAssignmentSchema,
} from './task.js';

describe('Task Schemas', () => {
  describe('TaskStatusSchema', () => {
    it('should validate valid statuses', () => {
      expect(TaskStatusSchema.parse('open')).toBe('open');
      expect(TaskStatusSchema.parse('in_progress')).toBe('in_progress');
      expect(TaskStatusSchema.parse('completed')).toBe('completed');
      expect(TaskStatusSchema.parse('blocked')).toBe('blocked');
    });

    it('should reject invalid status', () => {
      expect(() => TaskStatusSchema.parse('done')).toThrow();
      expect(() => TaskStatusSchema.parse('pending')).toThrow();
    });
  });

  describe('TaskPrioritySchema', () => {
    it('should validate P1-P4 priorities', () => {
      expect(TaskPrioritySchema.parse('P1')).toBe('P1');
      expect(TaskPrioritySchema.parse('P2')).toBe('P2');
      expect(TaskPrioritySchema.parse('P3')).toBe('P3');
      expect(TaskPrioritySchema.parse('P4')).toBe('P4');
    });

    it('should reject invalid priorities', () => {
      expect(() => TaskPrioritySchema.parse('P0')).toThrow();
      expect(() => TaskPrioritySchema.parse('P5')).toThrow();
      expect(() => TaskPrioritySchema.parse('high')).toThrow();
    });
  });

  describe('TaskTypeSchema', () => {
    it('should validate task types', () => {
      expect(TaskTypeSchema.parse('task')).toBe('task');
      expect(TaskTypeSchema.parse('bug')).toBe('bug');
      expect(TaskTypeSchema.parse('feature')).toBe('feature');
      expect(TaskTypeSchema.parse('epic')).toBe('epic');
    });

    it('should reject invalid types', () => {
      expect(() => TaskTypeSchema.parse('story')).toThrow();
      expect(() => TaskTypeSchema.parse('issue')).toThrow();
    });
  });

  describe('TaskSchema', () => {
    it('should validate complete task', () => {
      const task = {
        id: 'beads-001',
        title: 'Implement user authentication',
        description: 'Add JWT-based authentication',
        status: 'in_progress',
        priority: 'P2',
        type: 'feature',
        assignee: 'FullStack',
        blockedBy: ['beads-000'],
        blocking: ['beads-002', 'beads-003'],
        created: '2025-01-20T10:00:00Z',
        updated: '2025-01-22T09:00:00Z',
      };
      const result = TaskSchema.parse(task);
      expect(result.id).toBe('beads-001');
      expect(result.status).toBe('in_progress');
      expect(result.blockedBy).toHaveLength(1);
      expect(result.blocking).toHaveLength(2);
    });

    it('should allow task without optional fields', () => {
      const task = {
        id: 'beads-002',
        title: 'Fix login bug',
        status: 'open',
        priority: 'P1',
        type: 'bug',
        created: '2025-01-22T08:00:00Z',
        updated: '2025-01-22T08:00:00Z',
      };
      const result = TaskSchema.parse(task);
      expect(result.description).toBeUndefined();
      expect(result.assignee).toBeUndefined();
      expect(result.blockedBy).toBeUndefined();
    });

    it('should reject task with missing required fields', () => {
      expect(() =>
        TaskSchema.parse({
          id: 'beads-003',
          title: 'Incomplete task',
        })
      ).toThrow();
    });
  });

  describe('TaskAssignmentStatusSchema', () => {
    it('should validate all assignment statuses', () => {
      expect(TaskAssignmentStatusSchema.parse('pending')).toBe('pending');
      expect(TaskAssignmentStatusSchema.parse('assigned')).toBe('assigned');
      expect(TaskAssignmentStatusSchema.parse('in_progress')).toBe('in_progress');
      expect(TaskAssignmentStatusSchema.parse('completed')).toBe('completed');
      expect(TaskAssignmentStatusSchema.parse('failed')).toBe('failed');
    });
  });

  describe('TaskAssignmentPrioritySchema', () => {
    it('should validate assignment priorities', () => {
      expect(TaskAssignmentPrioritySchema.parse('low')).toBe('low');
      expect(TaskAssignmentPrioritySchema.parse('medium')).toBe('medium');
      expect(TaskAssignmentPrioritySchema.parse('high')).toBe('high');
      expect(TaskAssignmentPrioritySchema.parse('critical')).toBe('critical');
    });

    it('should reject invalid priority', () => {
      expect(() => TaskAssignmentPrioritySchema.parse('urgent')).toThrow();
    });
  });

  describe('TaskAssignmentSchema', () => {
    it('should validate complete assignment', () => {
      const assignment = {
        id: 'task-assign-001',
        agentName: 'FullStack',
        title: 'Build API endpoint',
        description: 'Create REST endpoint for user data',
        priority: 'high',
        status: 'in_progress',
        createdAt: '2025-01-22T08:00:00Z',
        assignedAt: '2025-01-22T08:05:00Z',
      };
      const result = TaskAssignmentSchema.parse(assignment);
      expect(result.agentName).toBe('FullStack');
      expect(result.priority).toBe('high');
      expect(result.status).toBe('in_progress');
    });

    it('should validate completed assignment', () => {
      const assignment = {
        id: 'task-assign-002',
        agentName: 'Backend',
        title: 'Database migration',
        description: 'Run schema migrations',
        priority: 'medium',
        status: 'completed',
        createdAt: '2025-01-21T10:00:00Z',
        assignedAt: '2025-01-21T10:30:00Z',
        completedAt: '2025-01-21T12:00:00Z',
        result: 'Migration completed successfully. 3 tables updated.',
      };
      const result = TaskAssignmentSchema.parse(assignment);
      expect(result.status).toBe('completed');
      expect(result.completedAt).toBeDefined();
      expect(result.result).toContain('Migration');
    });

    it('should allow pending assignment without dates', () => {
      const assignment = {
        id: 'task-assign-003',
        agentName: 'Worker',
        title: 'Pending task',
        description: 'Waiting for assignment',
        priority: 'low',
        status: 'pending',
        createdAt: '2025-01-22T09:00:00Z',
      };
      const result = TaskAssignmentSchema.parse(assignment);
      expect(result.assignedAt).toBeUndefined();
      expect(result.completedAt).toBeUndefined();
    });

    it('should reject assignment with missing required fields', () => {
      expect(() =>
        TaskAssignmentSchema.parse({
          id: 'task-assign-004',
          agentName: 'Worker',
        })
      ).toThrow();
    });
  });
});
