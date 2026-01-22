/**
 * Webhook Parsers Index
 *
 * Registry of all available parsers.
 */

import type { WebhookParser } from '../types.js';
import { githubParser } from './github.js';
import { linearParser } from './linear.js';
import { slackParser } from './slack.js';

/**
 * Registry of all available parsers
 */
export const parsers: Record<string, WebhookParser> = {
  github: githubParser,
  linear: linearParser,
  slack: slackParser,
};

/**
 * Get a parser by ID
 */
export function getParser(id: string): WebhookParser | undefined {
  return parsers[id];
}

/**
 * Register a custom parser
 */
export function registerParser(parser: WebhookParser): void {
  parsers[parser.id] = parser;
}

export { githubParser, linearParser, slackParser };
