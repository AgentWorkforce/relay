/**
 * Webhook Rules Engine
 *
 * Matches normalized events against configured rules and determines actions to take.
 */

import type { NormalizedEvent, WebhookRule, WebhookAction } from './types.js';

/**
 * Simple JSONPath-like evaluator for conditions
 * Supports: $.field, $.field.subfield, comparisons (==, !=, in, contains)
 */
function evaluateCondition(condition: string, event: NormalizedEvent): boolean {
  if (!condition || condition.trim() === '') return true;

  try {
    // Parse condition: $.path operator value
    // Note: >= and <= must come before > and < in the alternation to match correctly
    const conditionPattern = /^\$\.([a-zA-Z0-9_.]+)\s*(==|!=|>=|<=|>|<|in|contains)\s*(.+)$/;
    const match = condition.match(conditionPattern);

    if (!match) {
      console.warn(`[rules-engine] Invalid condition format: ${condition}`);
      return false;
    }

    const [, path, operator, rawValue] = match;
    const value = rawValue.trim();

    // Get the value from the event
    const eventValue = getValueByPath(event, path);

    // Parse the comparison value
    let compareValue: unknown;
    if (value.startsWith('[') && value.endsWith(']')) {
      // Array literal
      compareValue = JSON.parse(value);
    } else if (value.startsWith('"') && value.endsWith('"')) {
      // String literal
      compareValue = value.slice(1, -1);
    } else if (value === 'true') {
      compareValue = true;
    } else if (value === 'false') {
      compareValue = false;
    } else if (value === 'null') {
      compareValue = null;
    } else if (!isNaN(Number(value))) {
      compareValue = Number(value);
    } else {
      // Treat as string
      compareValue = value;
    }

    switch (operator) {
      case '==':
        // Handle null/undefined equivalence
        if (compareValue === null) {
          return eventValue === null || eventValue === undefined;
        }
        return eventValue === compareValue;
      case '!=':
        return eventValue !== compareValue;
      case 'in':
        return Array.isArray(compareValue) && compareValue.includes(eventValue);
      case 'contains':
        if (Array.isArray(eventValue)) {
          return eventValue.includes(compareValue);
        }
        if (typeof eventValue === 'string' && typeof compareValue === 'string') {
          return eventValue.includes(compareValue);
        }
        return false;
      case '>':
        return typeof eventValue === 'number' && typeof compareValue === 'number' && eventValue > compareValue;
      case '<':
        return typeof eventValue === 'number' && typeof compareValue === 'number' && eventValue < compareValue;
      case '>=':
        return typeof eventValue === 'number' && typeof compareValue === 'number' && eventValue >= compareValue;
      case '<=':
        return typeof eventValue === 'number' && typeof compareValue === 'number' && eventValue <= compareValue;
      default:
        return false;
    }
  } catch (error) {
    console.error(`[rules-engine] Error evaluating condition: ${condition}`, error);
    return false;
  }
}

/**
 * Get a value from an object by dot-separated path
 */
function getValueByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Check if a rule matches an event
 */
export function matchesRule(rule: WebhookRule, event: NormalizedEvent): boolean {
  // Check if rule is enabled
  if (!rule.enabled) return false;

  // Check source match
  if (rule.source !== '*' && rule.source !== event.source) {
    return false;
  }

  // Check event type match
  if (rule.eventType !== '*' && rule.eventType !== event.type) {
    // Support wildcard prefix matching (e.g., 'ci_*' matches 'ci_failure')
    if (rule.eventType.endsWith('*')) {
      const prefix = rule.eventType.slice(0, -1);
      if (!event.type.startsWith(prefix)) {
        return false;
      }
    } else {
      return false;
    }
  }

  // Check condition if present
  if (rule.condition && !evaluateCondition(rule.condition, event)) {
    return false;
  }

  return true;
}

/**
 * Find all matching rules for an event, sorted by priority
 */
export function findMatchingRules(rules: WebhookRule[], event: NormalizedEvent): WebhookRule[] {
  return rules
    .filter(rule => matchesRule(rule, event))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Resolve template variables in action configuration
 * Supports: ${event.field}, ${event.field.subfield}
 */
export function resolveActionTemplate(action: WebhookAction, event: NormalizedEvent): WebhookAction {
  const resolvedAction = { ...action };

  // Resolve agentType if it references an event field
  if (resolvedAction.agentType?.startsWith('$.')) {
    const path = resolvedAction.agentType.slice(2);
    const value = getValueByPath(event, path);
    if (typeof value === 'string') {
      resolvedAction.agentType = value;
    } else if (Array.isArray(value) && value.length > 0) {
      // Use first mentioned agent
      resolvedAction.agentType = String(value[0]);
    }
  }

  // Resolve prompt template references
  if (resolvedAction.prompt?.startsWith('${') && resolvedAction.prompt?.endsWith('}')) {
    const path = resolvedAction.prompt.slice(2, -1);
    const value = getValueByPath(event, path);
    if (typeof value === 'string') {
      resolvedAction.prompt = value;
    }
  }

  return resolvedAction;
}

/**
 * Default rules for common patterns
 */
export const defaultRules: WebhookRule[] = [
  // CI Failures
  {
    id: 'ci-failure',
    name: 'CI Failure Handler',
    enabled: true,
    source: 'github',
    eventType: 'ci_failure',
    action: {
      type: 'spawn_agent',
      agentType: 'ci-fix',
      prompt: 'ci-failure',
    },
    priority: 10,
  },
  // GitHub Mentions
  {
    id: 'github-mention',
    name: 'GitHub Mention Handler',
    enabled: true,
    source: 'github',
    eventType: 'mention',
    action: {
      type: 'spawn_agent',
      agentType: '$.mentions', // Use first mentioned agent
      prompt: 'mention',
    },
    priority: 20,
  },
  // GitHub Issues
  {
    id: 'github-issue',
    name: 'GitHub Issue Handler',
    enabled: true,
    source: 'github',
    eventType: 'issue_created',
    condition: '$.priority in ["critical", "high"]',
    action: {
      type: 'spawn_agent',
      agentType: 'developer',
      prompt: 'issue',
    },
    priority: 30,
  },
  // Linear Issues
  {
    id: 'linear-issue',
    name: 'Linear Issue Handler',
    enabled: true,
    source: 'linear',
    eventType: 'issue_created',
    action: {
      type: 'spawn_agent',
      agentType: 'developer',
      prompt: 'linear-issue',
    },
    priority: 20,
  },
  // Linear Mentions
  {
    id: 'linear-mention',
    name: 'Linear Mention Handler',
    enabled: true,
    source: 'linear',
    eventType: 'mention',
    action: {
      type: 'spawn_agent',
      agentType: '$.mentions',
      prompt: 'mention',
    },
    priority: 20,
  },
  // Slack App Mentions
  {
    id: 'slack-mention',
    name: 'Slack App Mention Handler',
    enabled: true,
    source: 'slack',
    eventType: 'mention',
    action: {
      type: 'spawn_agent',
      agentType: '$.mentions',
      prompt: 'slack-request',
    },
    priority: 20,
  },
  // Linear Issue Assignments (native integration)
  {
    id: 'linear-assignment',
    name: 'Linear Issue Assignment Handler',
    enabled: true,
    source: 'linear',
    eventType: 'issue_assigned',
    action: {
      type: 'spawn_agent',
      agentType: '$.mentions', // Use the assigned agent type
      prompt: 'linear-issue',
    },
    priority: 15,
  },
  // GitHub Issue Assignments
  {
    id: 'github-assignment',
    name: 'GitHub Issue Assignment Handler',
    enabled: true,
    source: 'github',
    eventType: 'issue_assigned',
    action: {
      type: 'spawn_agent',
      agentType: '$.mentions',
      prompt: 'issue',
    },
    priority: 15,
  },
];
