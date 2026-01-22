/**
 * Rules Engine Tests
 */

import { describe, it, expect } from 'vitest';
import {
  matchesRule,
  findMatchingRules,
  resolveActionTemplate,
  defaultRules,
} from './rules-engine.js';
import type { NormalizedEvent, WebhookRule } from './types.js';

const createEvent = (overrides: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  id: 'test-event-1',
  source: 'github',
  type: 'mention',
  timestamp: new Date(),
  actor: { id: 'user-1', name: 'testuser' },
  context: { name: 'owner/repo' },
  mentions: ['developer'],
  labels: [],
  metadata: {},
  rawPayload: {},
  ...overrides,
});

const createRule = (overrides: Partial<WebhookRule> = {}): WebhookRule => ({
  id: 'test-rule',
  name: 'Test Rule',
  enabled: true,
  source: '*',
  eventType: '*',
  action: { type: 'spawn_agent', agentType: 'developer' },
  priority: 10,
  ...overrides,
});

describe('matchesRule', () => {
  describe('enabled/disabled', () => {
    it('should not match disabled rules', () => {
      const rule = createRule({ enabled: false });
      const event = createEvent();

      expect(matchesRule(rule, event)).toBe(false);
    });

    it('should match enabled rules', () => {
      const rule = createRule({ enabled: true });
      const event = createEvent();

      expect(matchesRule(rule, event)).toBe(true);
    });
  });

  describe('source matching', () => {
    it('should match wildcard source', () => {
      const rule = createRule({ source: '*' });
      const event = createEvent({ source: 'github' });

      expect(matchesRule(rule, event)).toBe(true);
    });

    it('should match exact source', () => {
      const rule = createRule({ source: 'github' });
      const event = createEvent({ source: 'github' });

      expect(matchesRule(rule, event)).toBe(true);
    });

    it('should not match different source', () => {
      const rule = createRule({ source: 'linear' });
      const event = createEvent({ source: 'github' });

      expect(matchesRule(rule, event)).toBe(false);
    });
  });

  describe('eventType matching', () => {
    it('should match wildcard eventType', () => {
      const rule = createRule({ eventType: '*' });
      const event = createEvent({ type: 'ci_failure' });

      expect(matchesRule(rule, event)).toBe(true);
    });

    it('should match exact eventType', () => {
      const rule = createRule({ eventType: 'mention' });
      const event = createEvent({ type: 'mention' });

      expect(matchesRule(rule, event)).toBe(true);
    });

    it('should match prefix wildcard', () => {
      const rule = createRule({ eventType: 'ci_*' });

      expect(matchesRule(rule, createEvent({ type: 'ci_failure' }))).toBe(true);
      expect(matchesRule(rule, createEvent({ type: 'ci_success' }))).toBe(true);
      expect(matchesRule(rule, createEvent({ type: 'issue_created' }))).toBe(false);
    });

    it('should not match different eventType', () => {
      const rule = createRule({ eventType: 'ci_failure' });
      const event = createEvent({ type: 'mention' });

      expect(matchesRule(rule, event)).toBe(false);
    });
  });

  describe('condition evaluation', () => {
    it('should match without condition', () => {
      const rule = createRule({ condition: undefined });
      const event = createEvent();

      expect(matchesRule(rule, event)).toBe(true);
    });

    it('should match empty condition', () => {
      const rule = createRule({ condition: '' });
      const event = createEvent();

      expect(matchesRule(rule, event)).toBe(true);
    });

    it('should evaluate == condition', () => {
      const rule = createRule({ condition: '$.priority == "high"' });

      expect(matchesRule(rule, createEvent({ priority: 'high' }))).toBe(true);
      expect(matchesRule(rule, createEvent({ priority: 'low' }))).toBe(false);
    });

    it('should evaluate != condition', () => {
      const rule = createRule({ condition: '$.priority != "low"' });

      expect(matchesRule(rule, createEvent({ priority: 'high' }))).toBe(true);
      expect(matchesRule(rule, createEvent({ priority: 'low' }))).toBe(false);
    });

    it('should evaluate "in" condition with array', () => {
      const rule = createRule({ condition: '$.priority in ["critical", "high"]' });

      expect(matchesRule(rule, createEvent({ priority: 'critical' }))).toBe(true);
      expect(matchesRule(rule, createEvent({ priority: 'high' }))).toBe(true);
      expect(matchesRule(rule, createEvent({ priority: 'medium' }))).toBe(false);
    });

    it('should evaluate "contains" condition for arrays', () => {
      const rule = createRule({ condition: '$.labels contains "bug"' });

      expect(matchesRule(rule, createEvent({ labels: ['bug', 'critical'] }))).toBe(true);
      expect(matchesRule(rule, createEvent({ labels: ['feature'] }))).toBe(false);
    });

    it('should evaluate "contains" condition for strings', () => {
      const rule = createRule({ condition: '$.actor.name contains "test"' });

      expect(matchesRule(rule, createEvent({ actor: { id: '1', name: 'testuser' } }))).toBe(true);
      expect(matchesRule(rule, createEvent({ actor: { id: '1', name: 'admin' } }))).toBe(false);
    });

    it('should evaluate numeric comparisons', () => {
      const event = createEvent({ metadata: { count: 5 } });

      expect(matchesRule(createRule({ condition: '$.metadata.count > 3' }), event)).toBe(true);
      expect(matchesRule(createRule({ condition: '$.metadata.count < 3' }), event)).toBe(false);
      expect(matchesRule(createRule({ condition: '$.metadata.count >= 5' }), event)).toBe(true);
      expect(matchesRule(createRule({ condition: '$.metadata.count <= 5' }), event)).toBe(true);
    });

    it('should evaluate boolean conditions', () => {
      const rule = createRule({ condition: '$.metadata.urgent == true' });

      expect(matchesRule(rule, createEvent({ metadata: { urgent: true } }))).toBe(true);
      expect(matchesRule(rule, createEvent({ metadata: { urgent: false } }))).toBe(false);
    });

    it('should evaluate null conditions', () => {
      const rule = createRule({ condition: '$.priority == null' });

      expect(matchesRule(rule, createEvent({ priority: undefined }))).toBe(true);
      expect(matchesRule(rule, createEvent({ priority: 'high' }))).toBe(false);
    });

    it('should handle nested path access', () => {
      const rule = createRule({ condition: '$.metadata.check.name == "build"' });
      const event = createEvent({
        metadata: { check: { name: 'build' } },
      });

      expect(matchesRule(rule, event)).toBe(true);
    });

    it('should handle invalid condition gracefully', () => {
      const rule = createRule({ condition: 'invalid condition syntax' });
      const event = createEvent();

      expect(matchesRule(rule, event)).toBe(false);
    });
  });
});

describe('findMatchingRules', () => {
  it('should return matching rules sorted by priority', () => {
    const rules: WebhookRule[] = [
      createRule({ id: 'rule-3', priority: 30 }),
      createRule({ id: 'rule-1', priority: 10 }),
      createRule({ id: 'rule-2', priority: 20 }),
    ];
    const event = createEvent();

    const matched = findMatchingRules(rules, event);

    expect(matched).toHaveLength(3);
    expect(matched[0].id).toBe('rule-1');
    expect(matched[1].id).toBe('rule-2');
    expect(matched[2].id).toBe('rule-3');
  });

  it('should filter out non-matching rules', () => {
    const rules: WebhookRule[] = [
      createRule({ id: 'match-1', source: 'github' }),
      createRule({ id: 'no-match', source: 'linear' }),
      createRule({ id: 'match-2', source: '*' }),
    ];
    const event = createEvent({ source: 'github' });

    const matched = findMatchingRules(rules, event);

    expect(matched).toHaveLength(2);
    expect(matched.map(r => r.id)).toContain('match-1');
    expect(matched.map(r => r.id)).toContain('match-2');
  });

  it('should return empty array if no rules match', () => {
    const rules: WebhookRule[] = [
      createRule({ source: 'linear' }),
      createRule({ eventType: 'ci_failure' }),
    ];
    const event = createEvent({ source: 'github', type: 'mention' });

    const matched = findMatchingRules(rules, event);

    expect(matched).toHaveLength(0);
  });
});

describe('resolveActionTemplate', () => {
  it('should resolve $.mentions to first mention', () => {
    const action = { type: 'spawn_agent' as const, agentType: '$.mentions' };
    const event = createEvent({ mentions: ['developer', 'reviewer'] });

    const resolved = resolveActionTemplate(action, event);

    expect(resolved.agentType).toBe('developer');
  });

  it('should resolve nested path', () => {
    const action = { type: 'spawn_agent' as const, agentType: '$.metadata.agentType' };
    const event = createEvent({ metadata: { agentType: 'ci-fix' } });

    const resolved = resolveActionTemplate(action, event);

    expect(resolved.agentType).toBe('ci-fix');
  });

  it('should keep literal agent type', () => {
    const action = { type: 'spawn_agent' as const, agentType: 'developer' };
    const event = createEvent();

    const resolved = resolveActionTemplate(action, event);

    expect(resolved.agentType).toBe('developer');
  });

  it('should resolve prompt template references', () => {
    const action = { type: 'spawn_agent' as const, prompt: '${item.body}' };
    const event = createEvent({ item: { type: 'issue', id: '1', body: 'Fix the bug' } });

    const resolved = resolveActionTemplate(action, event);

    expect(resolved.prompt).toBe('Fix the bug');
  });
});

describe('defaultRules', () => {
  it('should have CI failure rule for GitHub', () => {
    const ciRule = defaultRules.find(r => r.id === 'ci-failure');

    expect(ciRule).toBeDefined();
    expect(ciRule?.source).toBe('github');
    expect(ciRule?.eventType).toBe('ci_failure');
    expect(ciRule?.action.agentType).toBe('ci-fix');
  });

  it('should have mention rules for all sources', () => {
    const githubMention = defaultRules.find(r => r.id === 'github-mention');
    const linearMention = defaultRules.find(r => r.id === 'linear-mention');
    const slackMention = defaultRules.find(r => r.id === 'slack-mention');

    expect(githubMention).toBeDefined();
    expect(linearMention).toBeDefined();
    expect(slackMention).toBeDefined();
  });

  it('should have assignment rules', () => {
    const linearAssignment = defaultRules.find(r => r.id === 'linear-assignment');
    const githubAssignment = defaultRules.find(r => r.id === 'github-assignment');

    expect(linearAssignment).toBeDefined();
    expect(githubAssignment).toBeDefined();
    expect(linearAssignment?.eventType).toBe('issue_assigned');
  });

  it('should have all rules enabled by default', () => {
    for (const rule of defaultRules) {
      expect(rule.enabled).toBe(true);
    }
  });

  it('should match CI failure event', () => {
    const ciRule = defaultRules.find(r => r.id === 'ci-failure')!;
    const event = createEvent({
      source: 'github',
      type: 'ci_failure',
    });

    expect(matchesRule(ciRule, event)).toBe(true);
  });

  it('should match GitHub high priority issue', () => {
    const issueRule = defaultRules.find(r => r.id === 'github-issue')!;
    const highPriorityEvent = createEvent({
      source: 'github',
      type: 'issue_created',
      priority: 'high',
    });
    const lowPriorityEvent = createEvent({
      source: 'github',
      type: 'issue_created',
      priority: 'low',
    });

    expect(matchesRule(issueRule, highPriorityEvent)).toBe(true);
    expect(matchesRule(issueRule, lowPriorityEvent)).toBe(false);
  });
});
