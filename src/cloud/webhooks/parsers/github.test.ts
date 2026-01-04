/**
 * GitHub Parser Tests
 */

import { describe, it, expect } from 'vitest';
import { githubParser } from './github.js';

describe('githubParser', () => {
  describe('check_run events', () => {
    it('should parse CI failure event', () => {
      const payload = {
        action: 'completed',
        check_run: {
          id: 12345,
          name: 'build',
          conclusion: 'failure',
          html_url: 'https://github.com/owner/repo/runs/12345',
          pull_requests: [
            {
              number: 42,
              head: { ref: 'feature-branch', sha: 'abc123' },
            },
          ],
          output: {
            title: 'Build failed',
            summary: 'TypeScript compilation errors',
            text: 'Error details here',
            annotations: [
              {
                path: 'src/index.ts',
                start_line: 10,
                end_line: 10,
                annotation_level: 'failure',
                message: "Cannot find name 'foo'",
              },
            ],
          },
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        sender: {
          id: 123,
          login: 'github-actions',
        },
      };

      const headers = {
        'x-github-event': 'check_run',
        'x-github-delivery': 'delivery-123',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('ci_failure');
      expect(events[0].source).toBe('github');
      expect(events[0].context.name).toBe('owner/repo');
      expect(events[0].item?.type).toBe('check');
      expect(events[0].item?.number).toBe(42);
      expect(events[0].metadata?.checkName).toBe('build');
      expect(events[0].metadata?.annotations).toHaveLength(1);
    });

    it('should not create CI failure event for successful check run', () => {
      const payload = {
        action: 'completed',
        check_run: {
          id: 12345,
          name: 'build',
          conclusion: 'success',
          pull_requests: [{ number: 42, head: { ref: 'main', sha: 'abc' } }],
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'user' },
      };

      const headers = {
        'x-github-event': 'check_run',
        'x-github-delivery': 'delivery-123',
      };

      const events = githubParser.parse(payload, headers);

      // Should not create a ci_failure event (may create generic event or none)
      const ciFailureEvents = events.filter(e => e.type === 'ci_failure');
      expect(ciFailureEvents).toHaveLength(0);
    });

    it('should not create CI failure event for check run without PR', () => {
      const payload = {
        action: 'completed',
        check_run: {
          id: 12345,
          name: 'build',
          conclusion: 'failure',
          pull_requests: [],
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'user' },
      };

      const headers = {
        'x-github-event': 'check_run',
        'x-github-delivery': 'delivery-123',
      };

      const events = githubParser.parse(payload, headers);

      // Should not create a ci_failure event (may create generic event or none)
      const ciFailureEvents = events.filter(e => e.type === 'ci_failure');
      expect(ciFailureEvents).toHaveLength(0);
    });
  });

  describe('issue_comment events', () => {
    it('should parse mention in issue comment', () => {
      const payload = {
        action: 'created',
        issue: {
          number: 42,
          title: 'Bug report',
          html_url: 'https://github.com/owner/repo/issues/42',
        },
        comment: {
          id: 789,
          body: '@developer please fix this bug',
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-789',
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        sender: {
          id: 123,
          login: 'reporter',
        },
      };

      const headers = {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-456',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mention');
      expect(events[0].mentions).toContain('developer');
      expect(events[0].item?.number).toBe(42);
      expect(events[0].item?.body).toBe('@developer please fix this bug');
    });

    it('should extract multiple mentions', () => {
      const payload = {
        action: 'created',
        issue: { number: 42, title: 'Issue' },
        comment: {
          id: 789,
          body: '@lead please assign this to @developer or @reviewer',
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-789',
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'user' },
      };

      const headers = {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-456',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].mentions).toContain('lead');
      expect(events[0].mentions).toContain('developer');
      expect(events[0].mentions).toContain('reviewer');
    });

    it('should not create mention event if no mentions', () => {
      const payload = {
        action: 'created',
        issue: { number: 42, title: 'Issue' },
        comment: {
          id: 789,
          body: 'This is a regular comment',
          html_url: 'https://github.com/owner/repo/issues/42#issuecomment-789',
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'user' },
      };

      const headers = {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-456',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(0);
    });

    it('should identify PR comments vs issue comments', () => {
      const payload = {
        action: 'created',
        issue: {
          number: 42,
          title: 'Fix bug',
          pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/42' },
        },
        comment: {
          id: 789,
          body: '@reviewer please check this',
          html_url: 'https://github.com/owner/repo/pull/42#issuecomment-789',
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'developer' },
      };

      const headers = {
        'x-github-event': 'issue_comment',
        'x-github-delivery': 'delivery-456',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].item?.type).toBe('pull_request');
      expect(events[0].metadata?.isPR).toBe(true);
    });
  });

  describe('issues events', () => {
    it('should parse issue created event', () => {
      const payload = {
        action: 'opened',
        issue: {
          id: 123,
          number: 42,
          title: 'Critical bug in production',
          body: 'The app crashes when users try to login',
          html_url: 'https://github.com/owner/repo/issues/42',
          state: 'open',
          labels: [
            { name: 'bug' },
            { name: 'critical' },
          ],
          assignees: [],
        },
        repository: {
          full_name: 'owner/repo',
          html_url: 'https://github.com/owner/repo',
        },
        sender: {
          id: 123,
          login: 'reporter',
        },
      };

      const headers = {
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-789',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('issue_created');
      expect(events[0].item?.title).toBe('Critical bug in production');
      expect(events[0].labels).toContain('bug');
      expect(events[0].labels).toContain('critical');
      expect(events[0].priority).toBe('critical');
    });

    it('should extract mentions from issue body', () => {
      const payload = {
        action: 'opened',
        issue: {
          id: 123,
          number: 42,
          title: 'Feature request',
          body: 'Hey @lead, can we add this feature? cc @developer',
          html_url: 'https://github.com/owner/repo/issues/42',
          state: 'open',
          labels: [],
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'user' },
      };

      const headers = {
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-789',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].mentions).toContain('lead');
      expect(events[0].mentions).toContain('developer');
    });

    it('should map priority labels correctly', () => {
      const testCases = [
        { labels: [{ name: 'p0' }], expected: 'critical' },
        { labels: [{ name: 'p1' }], expected: 'high' },
        { labels: [{ name: 'high' }], expected: 'high' },
        { labels: [{ name: 'p2' }], expected: 'medium' },
        { labels: [{ name: 'medium' }], expected: 'medium' },
        { labels: [{ name: 'p3' }], expected: 'low' },
        { labels: [{ name: 'low' }], expected: 'low' },
        { labels: [{ name: 'enhancement' }], expected: undefined },
      ];

      for (const { labels, expected } of testCases) {
        const payload = {
          action: 'opened',
          issue: {
            id: 123,
            number: 42,
            title: 'Test',
            body: '',
            html_url: 'https://github.com/owner/repo/issues/42',
            state: 'open',
            labels,
          },
          repository: { full_name: 'owner/repo' },
          sender: { id: 123, login: 'user' },
        };

        const headers = {
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-789',
        };

        const events = githubParser.parse(payload, headers);
        expect(events[0].priority).toBe(expected);
      }
    });
  });

  describe('pull_request_review_comment events', () => {
    it('should parse review comment with mention', () => {
      const payload = {
        action: 'created',
        pull_request: {
          number: 42,
          title: 'Add feature',
        },
        comment: {
          id: 789,
          body: '@developer this needs to be refactored',
          html_url: 'https://github.com/owner/repo/pull/42#discussion_r789',
          path: 'src/index.ts',
          line: 25,
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'reviewer' },
      };

      const headers = {
        'x-github-event': 'pull_request_review_comment',
        'x-github-delivery': 'delivery-abc',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('mention');
      expect(events[0].mentions).toContain('developer');
      expect(events[0].metadata?.filePath).toBe('src/index.ts');
      expect(events[0].metadata?.line).toBe(25);
      expect(events[0].metadata?.isReviewComment).toBe(true);
    });
  });

  describe('pull_request events', () => {
    it('should parse PR opened event', () => {
      const payload = {
        action: 'opened',
        pull_request: {
          id: 123,
          number: 42,
          title: 'Add new feature',
          body: 'This PR adds the requested feature',
          html_url: 'https://github.com/owner/repo/pull/42',
          state: 'open',
          draft: false,
          head: { ref: 'feature-branch' },
          base: { ref: 'main' },
          labels: [],
        },
        repository: { full_name: 'owner/repo' },
        sender: { id: 123, login: 'developer' },
      };

      const headers = {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-def',
      };

      const events = githubParser.parse(payload, headers);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('pr_opened');
      expect(events[0].item?.title).toBe('Add new feature');
      expect(events[0].metadata?.head).toBe('feature-branch');
      expect(events[0].metadata?.base).toBe('main');
    });
  });
});
