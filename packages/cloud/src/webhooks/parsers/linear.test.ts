/**
 * Linear Parser Tests
 */

import { describe, it, expect } from 'vitest';
import { linearParser } from './linear.js';

describe('linearParser', () => {
  describe('Issue events', () => {
    it('should parse issue created event', () => {
      const payload = {
        action: 'create',
        type: 'Issue',
        webhookId: 'webhook-123',
        createdAt: '2024-01-15T10:00:00Z',
        data: {
          id: 'issue-123',
          number: 42,
          title: 'Implement new feature',
          description: 'We need to add a new dashboard component',
          url: 'https://linear.app/team/issue/ENG-42',
          identifier: 'ENG-42',
          priority: 2, // High
          estimate: 3,
          dueDate: '2024-01-30',
          state: { name: 'Todo' },
          labels: [
            { name: 'feature' },
            { name: 'frontend' },
          ],
          assignee: {
            id: 'user-1',
            name: 'John Developer',
            email: 'john@example.com',
          },
          creator: {
            id: 'user-2',
            name: 'Jane PM',
            email: 'jane@example.com',
          },
          team: {
            key: 'ENG',
            name: 'Engineering',
          },
          cycle: {
            name: 'Sprint 5',
          },
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('issue_created');
      expect(events[0].source).toBe('linear');
      expect(events[0].item?.type).toBe('ticket');
      expect(events[0].item?.title).toBe('Implement new feature');
      expect(events[0].item?.number).toBe(42);
      expect(events[0].priority).toBe('high');
      expect(events[0].labels).toContain('feature');
      expect(events[0].labels).toContain('frontend');
      expect(events[0].metadata?.identifier).toBe('ENG-42');
      expect(events[0].metadata?.assignee).toBe('John Developer');
      expect(events[0].actor.name).toBe('Jane PM');
      expect(events[0].context.name).toBe('ENG');
    });

    it('should map Linear priority correctly', () => {
      const testCases = [
        { priority: 1, expected: 'critical' },
        { priority: 2, expected: 'high' },
        { priority: 3, expected: 'medium' },
        { priority: 4, expected: 'low' },
        { priority: 0, expected: undefined },
        { priority: undefined, expected: undefined },
      ];

      for (const { priority, expected } of testCases) {
        const payload = {
          action: 'create',
          type: 'Issue',
          webhookId: 'webhook-123',
          data: {
            id: 'issue-123',
            title: 'Test',
            priority,
            team: { key: 'ENG' },
          },
        };

        const events = linearParser.parse(payload, {});
        expect(events[0].priority).toBe(expected);
      }
    });

    it('should detect agent assignment', () => {
      const payload = {
        action: 'update',
        type: 'Issue',
        webhookId: 'webhook-456',
        createdAt: '2024-01-15T11:00:00Z',
        updatedFrom: {
          assigneeId: null, // Was unassigned
        },
        data: {
          id: 'issue-123',
          number: 42,
          title: 'Fix authentication bug',
          description: 'Users cannot log in',
          url: 'https://linear.app/team/issue/ENG-42',
          identifier: 'ENG-42',
          state: { name: 'In Progress' },
          labels: [],
          assignee: {
            id: 'agent-developer-1',
            name: 'Developer Agent',
            email: 'developer@agents.local',
          },
          team: { key: 'ENG' },
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('issue_assigned');
      expect(events[0].mentions).toContain('developer');
      expect(events[0].metadata?.action).toBe('assigned');
    });

    it('should detect various agent name patterns', () => {
      const agentNames = [
        { name: 'Lead Agent', expectedAgent: 'lead' },
        { name: 'Developer Bot', expectedAgent: 'developer' },
        { name: 'Code Reviewer', expectedAgent: 'reviewer' },
        { name: 'CI-Fix Agent', expectedAgent: 'ci-fix' },
        { name: 'Test Bot', expectedAgent: 'test' },
        { name: 'Docs Agent', expectedAgent: 'docs' },
        { name: 'Refactor Bot', expectedAgent: 'refactor' },
        { name: 'Debugger', expectedAgent: 'debugger' },
      ];

      for (const { name, expectedAgent } of agentNames) {
        const payload = {
          action: 'update',
          type: 'Issue',
          webhookId: 'webhook-456',
          updatedFrom: { assigneeId: null },
          data: {
            id: 'issue-123',
            title: 'Test issue',
            state: { name: 'Todo' },
            labels: [],
            assignee: { id: 'agent-1', name },
            team: { key: 'ENG' },
          },
        };

        const events = linearParser.parse(payload, {});
        expect(events[0].type).toBe('issue_assigned');
        expect(events[0].mentions).toContain(expectedAgent);
      }
    });

    it('should not treat regular user assignment as agent assignment', () => {
      const payload = {
        action: 'update',
        type: 'Issue',
        webhookId: 'webhook-456',
        updatedFrom: { assigneeId: null },
        data: {
          id: 'issue-123',
          title: 'Test issue',
          state: { name: 'Todo' },
          labels: [],
          assignee: { id: 'user-1', name: 'John Smith' },
          team: { key: 'ENG' },
        },
      };

      const events = linearParser.parse(payload, {});
      expect(events[0].type).toBe('issue_updated');
      expect(events[0].type).not.toBe('issue_assigned');
    });

    it('should parse regular issue update', () => {
      const payload = {
        action: 'update',
        type: 'Issue',
        webhookId: 'webhook-789',
        updatedFrom: { stateId: 'state-1' },
        data: {
          id: 'issue-123',
          title: 'Test issue',
          state: { name: 'In Progress' },
          labels: [],
          team: { key: 'ENG' },
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('issue_updated');
    });

    it('should extract mentions from issue description', () => {
      const payload = {
        action: 'create',
        type: 'Issue',
        webhookId: 'webhook-123',
        data: {
          id: 'issue-123',
          title: 'Review request',
          description: 'Hey @lead, please review this. cc @developer',
          state: { name: 'Todo' },
          labels: [],
          team: { key: 'ENG' },
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events[0].mentions).toContain('lead');
      expect(events[0].mentions).toContain('developer');
    });
  });

  describe('Comment events', () => {
    it('should parse comment created event', () => {
      const payload = {
        action: 'create',
        type: 'Comment',
        webhookId: 'webhook-comment-123',
        createdAt: '2024-01-15T12:00:00Z',
        data: {
          id: 'comment-1',
          body: 'I found the root cause of this issue',
          url: 'https://linear.app/team/issue/ENG-42#comment-1',
          issue: {
            id: 'issue-123',
            number: 42,
            title: 'Bug report',
            identifier: 'ENG-42',
          },
          user: {
            id: 'user-1',
            name: 'Developer',
            email: 'dev@example.com',
          },
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('comment_created');
      expect(events[0].item?.type).toBe('comment');
      expect(events[0].item?.body).toBe('I found the root cause of this issue');
      expect(events[0].metadata?.issueIdentifier).toBe('ENG-42');
    });

    it('should parse comment with mentions', () => {
      const payload = {
        action: 'create',
        type: 'Comment',
        webhookId: 'webhook-comment-456',
        data: {
          id: 'comment-2',
          body: '@reviewer please take a look at this fix',
          url: 'https://linear.app/team/issue/ENG-42#comment-2',
          issue: {
            id: 'issue-123',
            number: 42,
            title: 'Bug report',
            identifier: 'ENG-42',
          },
          user: { id: 'user-1', name: 'Developer' },
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mention');
      expect(events[0].mentions).toContain('reviewer');
    });

    it('should not create event for comment without issue context', () => {
      const payload = {
        action: 'create',
        type: 'Comment',
        webhookId: 'webhook-comment-789',
        data: {
          id: 'comment-3',
          body: 'Orphan comment',
          // No issue field
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(0);
    });
  });

  describe('Project events', () => {
    it('should parse project created event', () => {
      const payload = {
        action: 'create',
        type: 'Project',
        webhookId: 'webhook-project-123',
        data: {
          id: 'project-1',
          name: 'Q1 Roadmap',
          description: 'Features for Q1 2024',
          url: 'https://linear.app/team/project/q1-roadmap',
          targetDate: '2024-03-31',
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('project_created');
      expect(events[0].context.name).toBe('Q1 Roadmap');
    });
  });

  describe('IssueLabel events', () => {
    it('should parse label change event', () => {
      const payload = {
        action: 'create',
        type: 'IssueLabel',
        webhookId: 'webhook-label-123',
        data: {
          id: 'label-1',
          name: 'bug',
          color: '#ff0000',
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('label_change');
      expect(events[0].labels).toContain('bug');
    });
  });

  describe('Unknown events', () => {
    it('should create generic event for unknown types', () => {
      const payload = {
        action: 'create',
        type: 'Workflow',
        webhookId: 'webhook-unknown-123',
        data: {
          id: 'workflow-1',
          name: 'Custom workflow',
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('linear.workflow.create');
    });
  });

  describe('Edge cases', () => {
    it('should handle missing data gracefully', () => {
      const payload = {
        action: 'create',
        type: 'Issue',
        webhookId: 'webhook-edge-1',
        // Missing data field
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(0);
    });

    it('should handle null/undefined fields', () => {
      const payload = {
        action: 'create',
        type: 'Issue',
        webhookId: 'webhook-edge-2',
        data: {
          id: 'issue-123',
          title: null,
          description: undefined,
          state: null,
          labels: null,
          team: null,
        },
      };

      const events = linearParser.parse(payload, {});

      expect(events).toHaveLength(1);
      expect(events[0].item?.title).toBe('');
    });
  });
});
