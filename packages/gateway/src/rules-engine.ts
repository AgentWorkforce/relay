/**
 * Gateway Rules Engine
 *
 * Matches normalized messages against configured rules and determines actions.
 * Supports JSONPath-like conditions with comparison operators.
 */

import type { NormalizedMessage, WebhookRule, GatewayAction } from './types.js';

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
 * Simple JSONPath-like evaluator for conditions.
 * Supports: $.field, $.field.subfield
 * Operators: ==, !=, >, <, >=, <=, in, contains
 */
export function evaluateCondition(condition: string, message: NormalizedMessage): boolean {
  if (!condition || condition.trim() === '') return true;

  try {
    const conditionPattern = /^\$\.([a-zA-Z0-9_.]+)\s*(==|!=|>=|<=|>|<|in|contains)\s*(.+)$/;
    const match = condition.match(conditionPattern);

    if (!match) {
      console.warn(`[rules-engine] Invalid condition format: ${condition}`);
      return false;
    }

    const [, path, operator, rawValue] = match;
    const value = rawValue.trim();

    const messageValue = getValueByPath(message, path);

    let compareValue: unknown;
    if (value.startsWith('[') && value.endsWith(']')) {
      compareValue = JSON.parse(value);
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
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
      compareValue = value;
    }

    switch (operator) {
      case '==':
        if (compareValue === null) {
          return messageValue === null || messageValue === undefined;
        }
        return messageValue === compareValue;
      case '!=':
        return messageValue !== compareValue;
      case 'in':
        return Array.isArray(compareValue) && compareValue.includes(messageValue);
      case 'contains':
        if (Array.isArray(messageValue)) {
          return messageValue.includes(compareValue);
        }
        if (typeof messageValue === 'string' && typeof compareValue === 'string') {
          return messageValue.includes(compareValue);
        }
        return false;
      case '>':
        return (
          typeof messageValue === 'number' && typeof compareValue === 'number' && messageValue > compareValue
        );
      case '<':
        return (
          typeof messageValue === 'number' && typeof compareValue === 'number' && messageValue < compareValue
        );
      case '>=':
        return (
          typeof messageValue === 'number' && typeof compareValue === 'number' && messageValue >= compareValue
        );
      case '<=':
        return (
          typeof messageValue === 'number' && typeof compareValue === 'number' && messageValue <= compareValue
        );
      default:
        return false;
    }
  } catch (error) {
    console.error(`[rules-engine] Error evaluating condition: ${condition}`, error);
    return false;
  }
}

/**
 * Check if a rule matches a normalized message
 */
export function matchesRule(rule: WebhookRule, message: NormalizedMessage): boolean {
  if (!rule.enabled) return false;

  if (rule.source !== '*' && rule.source !== message.source) {
    return false;
  }

  if (rule.eventType !== '*' && rule.eventType !== message.type) {
    if (rule.eventType.endsWith('*')) {
      const prefix = rule.eventType.slice(0, -1);
      if (!message.type.startsWith(prefix)) {
        return false;
      }
    } else {
      return false;
    }
  }

  if (rule.condition && !evaluateCondition(rule.condition, message)) {
    return false;
  }

  return true;
}

/**
 * Find all matching rules for a message, sorted by priority (lower = higher)
 */
export function findMatchingRules(rules: WebhookRule[], message: NormalizedMessage): WebhookRule[] {
  return rules.filter((rule) => matchesRule(rule, message)).sort((a, b) => a.priority - b.priority);
}

/**
 * Extract actions from matched rules
 */
export function extractActions(rules: WebhookRule[], message: NormalizedMessage): GatewayAction[] {
  const matched = findMatchingRules(rules, message);
  return matched.map((rule) => rule.action);
}
