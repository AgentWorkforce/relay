/**
 * Workers-compatible entry point for @agent-relay/sdk.
 *
 * Resolves in Cloudflare Workers / workerd runtimes via the "workerd"
 * export condition in package.json. Provides the Workers-safe subset
 * of the SDK:
 *
 *   - AgentRelayClient (connect-mode only — do NOT call .spawn() from
 *     a Worker, it requires node:child_process)
 *   - BrokerTransport, AgentRelayProtocolError
 *   - Protocol types and constants
 *   - Runtime / agent type definitions
 *   - Model constants and metadata
 *
 * EXPLICITLY EXCLUDED (anything that executes Node-only APIs at module
 * top level or pulls them transitively):
 *
 *   - workflows/* — pulls cli-session-collector which static-imports
 *     collectors/opencode.js and collectors/codex.js with top-level
 *     createRequire(import.meta.url). This is the exact failure mode
 *     that broke the AgentWorkforce cloud Sage worker deploy with
 *     Cloudflare error 10021.
 *   - logs (uses node:fs at top level)
 *   - relay-adapter (pulls workflows transitively)
 *   - pty (uses node:child_process at top level)
 *
 * If a consumer needs workflows or any Node-only surface, they import
 * the full SDK from a Node runtime via `@agent-relay/sdk` root — the
 * bundler resolver picks the "import" / "default" condition instead
 * of "workerd" and they get the full tree. Workers consumers get this
 * narrower surface automatically via export conditions — no code
 * changes in the consumer needed.
 */

export * from './protocol.js';
export * from './types.js';
export { BrokerTransport, type BrokerTransportOptions, AgentRelayProtocolError } from './transport.js';
export {
  AgentRelayClient,
  type AgentRelayBrokerInitArgs,
  type AgentRelayClientOptions,
  type AgentRelaySpawnOptions,
  type SessionInfo,
} from './client.js';
export * from './models.js';
