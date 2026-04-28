/**
 * Bundled GitHub workflow primitive.
 *
 * Re-exports the full surface of `@agent-relay/github-primitive` so
 * workflow authors can import it from the SDK without a separate
 * install:
 *
 *   import { createGitHubStep, GitHubClient } from '@agent-relay/sdk/github';
 *
 * `createGitHubStep` is the one most workflow authors reach for — it
 * produces an integration-type `.step(...)` config you drop straight
 * into `workflow(...)`. `GitHubClient` is the underlying typed client;
 * same methods, runnable outside a workflow too.
 */

export * from '@agent-relay/github-primitive';
