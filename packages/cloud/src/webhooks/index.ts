/**
 * Generic Webhook System
 *
 * A configurable webhook system that can handle events from any source
 * (GitHub, GitLab, Linear, Slack, Jira, etc.) and route them to agents.
 *
 * Components:
 * - Parsers: Transform source-specific payloads to normalized events
 * - Responders: Send responses back to source systems
 * - Rules Engine: Match events to actions based on configuration
 * - Router: Orchestrates the full webhook processing pipeline
 */

// Types
export * from './types.js';

// Parsers
export { getParser, registerParser, parsers } from './parsers/index.js';
export { githubParser } from './parsers/github.js';
export { linearParser } from './parsers/linear.js';
export { slackParser } from './parsers/slack.js';

// Responders
export { getResponder, registerResponder, responders } from './responders/index.js';
export { githubResponder } from './responders/github.js';
export { linearResponder } from './responders/linear.js';
export { slackResponder, formatSlackBlocks } from './responders/slack.js';

// Rules Engine
export {
  matchesRule,
  findMatchingRules,
  resolveActionTemplate,
  defaultRules,
} from './rules-engine.js';

// Router
export {
  processWebhook,
  getWebhookConfig,
  defaultSources,
} from './router.js';
