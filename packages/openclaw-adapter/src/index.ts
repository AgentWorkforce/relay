/**
 * OpenClaw Adapter for Agent Relay
 *
 * Bridges OpenClaw gateway agents into Relaycast workspaces,
 * making them appear as first-class citizens alongside other
 * Relay agents (Claude, Codex, Gemini, etc.).
 *
 * @example
 * ```typescript
 * import { OpenClawAdapter } from '@agent-relay/openclaw-adapter';
 *
 * const adapter = new OpenClawAdapter({
 *   gatewayUrl: 'ws://127.0.0.1:18789',
 *   workspaceKey: 'rk_live_xxx',
 *   channel: 'openclaw',
 *   debug: true,
 * });
 *
 * await adapter.start();
 * ```
 *
 * @packageDocumentation
 */

export { OpenClawAdapter } from './adapter.js';
export { OpenClawClient } from './openclaw-client.js';
export { AgentMap } from './agent-map.js';
export type { AgentMappingWithClient } from './agent-map.js';
export type {
  OpenClawAdapterOptions,
  OpenClawClientOptions,
  OpenClawAgent,
  OpenClawSession,
  OpenClawRunResult,
  SendResult,
  AgentMapping,
  GatewayRequest,
  GatewayResponse,
  GatewayEvent,
  GatewayFrame,
  PresenceEntry,
} from './types.js';
