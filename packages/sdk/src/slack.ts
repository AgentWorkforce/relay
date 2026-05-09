/**
 * Bundled Slack workflow primitive.
 *
 * Re-exports the full surface of `@agent-relay/slack-primitive` so
 * workflow authors can import it from the SDK without a separate
 * install. Three import shapes are supported:
 *
 *   // 1. Subpath (full surface):
 *   import { createSlackStep, SlackClient } from '@agent-relay/sdk/slack';
 *
 *   // 2. Namespaced from root (full surface, avoids collisions):
 *   import { slack } from '@agent-relay/sdk';
 *   slack.createSlackStep(...);
 *
 *   // 3. Direct from root (curated helpers only):
 *   import { createSlackStep, SlackClient } from '@agent-relay/sdk';
 *
 * `createSlackStep` is the one most workflow authors reach for — it
 * produces an integration-type `.step(...)` config you drop straight
 * into `workflow(...)`. `SlackClient` is the underlying typed client;
 * same methods, runnable outside a workflow too.
 */

export * from '@agent-relay/slack-primitive';
