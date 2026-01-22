/**
 * Decision Schema Tests
 */

import { describe, it, expect } from 'vitest';
import {
  DecisionUrgencySchema,
  DecisionCategorySchema,
  DecisionOptionSchema,
  ApiDecisionSchema,
  DecisionSchema,
  PendingDecisionSchema,
  TrajectoryDecisionTypeSchema,
  TrajectoryDecisionOutcomeSchema,
  TrajectoryDecisionSchema,
  TrajectorySchema,
} from './decision.js';

describe('Decision Schemas', () => {
  describe('DecisionUrgencySchema', () => {
    it('should validate urgency levels', () => {
      expect(DecisionUrgencySchema.parse('low')).toBe('low');
      expect(DecisionUrgencySchema.parse('medium')).toBe('medium');
      expect(DecisionUrgencySchema.parse('high')).toBe('high');
      expect(DecisionUrgencySchema.parse('critical')).toBe('critical');
    });

    it('should reject invalid urgency', () => {
      expect(() => DecisionUrgencySchema.parse('urgent')).toThrow();
      expect(() => DecisionUrgencySchema.parse('P1')).toThrow();
    });
  });

  describe('DecisionCategorySchema', () => {
    it('should validate categories', () => {
      expect(DecisionCategorySchema.parse('approval')).toBe('approval');
      expect(DecisionCategorySchema.parse('choice')).toBe('choice');
      expect(DecisionCategorySchema.parse('input')).toBe('input');
      expect(DecisionCategorySchema.parse('confirmation')).toBe('confirmation');
    });

    it('should reject invalid category', () => {
      expect(() => DecisionCategorySchema.parse('question')).toThrow();
    });
  });

  describe('DecisionOptionSchema', () => {
    it('should validate option with description', () => {
      const option = {
        id: 'opt-1',
        label: 'Option A',
        description: 'This is option A',
      };
      const result = DecisionOptionSchema.parse(option);
      expect(result.id).toBe('opt-1');
      expect(result.label).toBe('Option A');
    });

    it('should allow option without description', () => {
      const option = {
        id: 'opt-2',
        label: 'Option B',
      };
      const result = DecisionOptionSchema.parse(option);
      expect(result.description).toBeUndefined();
    });
  });

  describe('ApiDecisionSchema', () => {
    it('should validate complete API decision', () => {
      const decision = {
        id: 'dec-001',
        agentName: 'FullStack',
        title: 'Choose database',
        description: 'Select the database to use for the project',
        options: [
          { id: 'opt-1', label: 'PostgreSQL', description: 'Relational DB' },
          { id: 'opt-2', label: 'MongoDB', description: 'Document DB' },
        ],
        urgency: 'high',
        category: 'choice',
        createdAt: '2025-01-22T10:00:00Z',
        expiresAt: '2025-01-22T12:00:00Z',
        context: { projectType: 'web-app' },
      };
      const result = ApiDecisionSchema.parse(decision);
      expect(result.options).toHaveLength(2);
      expect(result.urgency).toBe('high');
      expect(result.category).toBe('choice');
    });

    it('should allow decision without options', () => {
      const decision = {
        id: 'dec-002',
        agentName: 'Worker',
        title: 'Approve deployment',
        description: 'Approve the deployment to production',
        urgency: 'critical',
        category: 'approval',
        createdAt: '2025-01-22T11:00:00Z',
      };
      const result = ApiDecisionSchema.parse(decision);
      expect(result.options).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe('DecisionSchema', () => {
    it('should validate decision with string timestamp', () => {
      const decision = {
        id: 'dec-003',
        agentName: 'Backend',
        timestamp: '2025-01-22T10:30:00Z',
        type: 'input',
        title: 'Enter API key',
        description: 'Provide the third-party API key',
        priority: 'medium',
      };
      const result = DecisionSchema.parse(decision);
      expect(result.timestamp).toBe('2025-01-22T10:30:00Z');
    });

    it('should validate decision with numeric timestamp', () => {
      const decision = {
        id: 'dec-004',
        agentName: 'Frontend',
        timestamp: 1705920600000,
        type: 'confirmation',
        title: 'Confirm delete',
        description: 'Are you sure you want to delete this file?',
        priority: 'low',
      };
      const result = DecisionSchema.parse(decision);
      expect(result.timestamp).toBe(1705920600000);
    });

    it('should validate decision with options and context', () => {
      const decision = {
        id: 'dec-005',
        agentName: 'Lead',
        timestamp: Date.now(),
        type: 'choice',
        title: 'Select framework',
        description: 'Choose the frontend framework',
        options: [
          { id: 'react', label: 'React' },
          { id: 'vue', label: 'Vue' },
        ],
        priority: 'high',
        context: { team: 'frontend' },
        expiresAt: '2025-01-23T10:00:00Z',
      };
      const result = DecisionSchema.parse(decision);
      expect(result.options).toHaveLength(2);
      expect(result.context).toEqual({ team: 'frontend' });
    });
  });

  describe('PendingDecisionSchema', () => {
    it('should validate pending decision', () => {
      const decision = {
        id: 'pending-001',
        agent: 'Worker',
        question: 'Which approach should we use?',
        options: ['Approach A', 'Approach B', 'Approach C'],
        context: 'Building new feature',
        priority: 'medium',
        createdAt: '2025-01-22T09:00:00Z',
        expiresAt: '2025-01-22T17:00:00Z',
      };
      const result = PendingDecisionSchema.parse(decision);
      expect(result.options).toHaveLength(3);
      expect(result.priority).toBe('medium');
    });

    it('should allow pending decision without options', () => {
      const decision = {
        id: 'pending-002',
        agent: 'Backend',
        question: 'What is the expected response format?',
        priority: 'low',
        createdAt: '2025-01-22T10:00:00Z',
      };
      const result = PendingDecisionSchema.parse(decision);
      expect(result.options).toBeUndefined();
      expect(result.context).toBeUndefined();
    });
  });

  describe('TrajectoryDecisionTypeSchema', () => {
    it('should validate decision types', () => {
      expect(TrajectoryDecisionTypeSchema.parse('tool_call')).toBe('tool_call');
      expect(TrajectoryDecisionTypeSchema.parse('message')).toBe('message');
      expect(TrajectoryDecisionTypeSchema.parse('file_edit')).toBe('file_edit');
      expect(TrajectoryDecisionTypeSchema.parse('command')).toBe('command');
      expect(TrajectoryDecisionTypeSchema.parse('question')).toBe('question');
    });
  });

  describe('TrajectoryDecisionOutcomeSchema', () => {
    it('should validate outcomes', () => {
      expect(TrajectoryDecisionOutcomeSchema.parse('success')).toBe('success');
      expect(TrajectoryDecisionOutcomeSchema.parse('error')).toBe('error');
      expect(TrajectoryDecisionOutcomeSchema.parse('pending')).toBe('pending');
    });
  });

  describe('TrajectoryDecisionSchema', () => {
    it('should validate simple trajectory decision', () => {
      const decision = {
        id: 'traj-001',
        timestamp: '2025-01-22T10:00:00Z',
        agent: 'FullStack',
        type: 'tool_call',
        summary: 'Read file package.json',
        details: 'Reading package.json to check dependencies',
        outcome: 'success',
      };
      const result = TrajectoryDecisionSchema.parse(decision);
      expect(result.id).toBe('traj-001');
      expect(result.type).toBe('tool_call');
      expect(result.outcome).toBe('success');
    });

    it('should validate trajectory decision with children (recursive)', () => {
      const decision = {
        id: 'traj-002',
        timestamp: '2025-01-22T10:05:00Z',
        agent: 'Lead',
        type: 'command',
        summary: 'Run build process',
        outcome: 'success',
        children: [
          {
            id: 'traj-003',
            timestamp: '2025-01-22T10:05:01Z',
            agent: 'Lead',
            type: 'tool_call',
            summary: 'Execute npm run build',
            outcome: 'success',
          },
          {
            id: 'traj-004',
            timestamp: '2025-01-22T10:05:30Z',
            agent: 'Lead',
            type: 'message',
            summary: 'Build completed',
            outcome: 'success',
          },
        ],
      };
      const result = TrajectoryDecisionSchema.parse(decision);
      expect(result.children).toHaveLength(2);
      expect(result.children?.[0].type).toBe('tool_call');
    });

    it('should validate deeply nested children', () => {
      const decision = {
        id: 'root',
        timestamp: '2025-01-22T10:00:00Z',
        agent: 'Root',
        type: 'command',
        summary: 'Root command',
        children: [
          {
            id: 'level-1',
            timestamp: '2025-01-22T10:01:00Z',
            agent: 'Root',
            type: 'tool_call',
            summary: 'Level 1',
            children: [
              {
                id: 'level-2',
                timestamp: '2025-01-22T10:02:00Z',
                agent: 'Root',
                type: 'file_edit',
                summary: 'Level 2',
              },
            ],
          },
        ],
      };
      const result = TrajectoryDecisionSchema.parse(decision);
      expect(result.children?.[0].children?.[0].id).toBe('level-2');
    });
  });

  describe('TrajectorySchema', () => {
    it('should validate complete trajectory', () => {
      const trajectory = {
        agentName: 'FullStack',
        sessionId: 'session-001',
        decisions: [
          {
            id: 'traj-001',
            timestamp: '2025-01-22T10:00:00Z',
            agent: 'FullStack',
            type: 'tool_call',
            summary: 'Start work',
            outcome: 'success',
          },
        ],
        startTime: '2025-01-22T10:00:00Z',
        endTime: '2025-01-22T12:00:00Z',
      };
      const result = TrajectorySchema.parse(trajectory);
      expect(result.agentName).toBe('FullStack');
      expect(result.decisions).toHaveLength(1);
      expect(result.endTime).toBe('2025-01-22T12:00:00Z');
    });

    it('should allow trajectory without endTime (in progress)', () => {
      const trajectory = {
        agentName: 'Worker',
        sessionId: 'session-002',
        decisions: [],
        startTime: '2025-01-22T11:00:00Z',
      };
      const result = TrajectorySchema.parse(trajectory);
      expect(result.endTime).toBeUndefined();
      expect(result.decisions).toHaveLength(0);
    });
  });
});
