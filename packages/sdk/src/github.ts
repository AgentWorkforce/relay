/**
 * Bundled GitHub workflow primitive.
 *
 * Re-exports the full surface of `@agent-relay/github-primitive` so
 * workflow authors can import it from the SDK without a separate
 * install. Three import shapes are supported:
 *
 *   // 1. Subpath (full surface):
 *   import { createGitHubStep, GitHubClient } from '@agent-relay/sdk/github';
 *
 *   // 2. Namespaced from root (full surface, avoids collisions):
 *   import { github } from '@agent-relay/sdk';
 *   github.createGitHubStep(...);
 *
 *   // 3. Direct from root (curated helpers only):
 *   import { createGitHubStep, GitHubClient } from '@agent-relay/sdk';
 *
 * `createGitHubStep` is the one most workflow authors reach for — it
 * produces an integration-type `.step(...)` config you drop straight
 * into `workflow(...)`. `GitHubClient` is the underlying typed client;
 * same methods, runnable outside a workflow too.
 */

export * from '@agent-relay/github-primitive';
