/**
 * Webhook Responders Index
 *
 * Registry of all available responders.
 */

import type { WebhookResponder } from '../types.js';
import { githubResponder } from './github.js';
import { linearResponder } from './linear.js';
import { slackResponder, formatSlackBlocks } from './slack.js';

/**
 * Registry of all available responders
 */
export const responders: Record<string, WebhookResponder> = {
  github: githubResponder,
  linear: linearResponder,
  slack: slackResponder,
};

/**
 * Get a responder by ID
 */
export function getResponder(id: string): WebhookResponder | undefined {
  return responders[id];
}

/**
 * Register a custom responder
 */
export function registerResponder(responder: WebhookResponder): void {
  responders[responder.id] = responder;
}

export { githubResponder, linearResponder, slackResponder, formatSlackBlocks };
