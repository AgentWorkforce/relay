/**
 * Shared types for the OpenClaw adapter
 * @agent-relay/openclaw-adapter
 */

// ── OpenClaw Gateway Types ──────────────────────────────────────────

/** An agent registered in the OpenClaw gateway */
export interface OpenClawAgent {
  id: string;
  workspace: string;
  identity?: { name?: string; emoji?: string };
}

/** An active session in the OpenClaw gateway */
export interface OpenClawSession {
  key: string;
  agentId: string;
  model?: string;
  lastActive?: string;
}

/** Result from running an agent task */
export interface OpenClawRunResult {
  runId: string;
  status: 'completed' | 'failed' | 'timeout';
  output?: string;
}

/** Result from sending a message to a session */
export interface SendResult {
  delivered: boolean;
  runId?: string;
}

// ── Gateway Protocol Frames ─────────────────────────────────────────

/** JSON-RPC request sent to the OpenClaw gateway */
export interface GatewayRequest {
  type: 'request';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC response from the OpenClaw gateway */
export interface GatewayResponse {
  type: 'response';
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Server-push event from the OpenClaw gateway */
export interface GatewayEvent {
  type: 'event';
  event: string;
  data: unknown;
}

/** Union of all gateway frame types */
export type GatewayFrame = GatewayRequest | GatewayResponse | GatewayEvent;

// ── OpenClaw Client Types ───────────────────────────────────────────

/** Options for connecting to an OpenClaw gateway */
export interface OpenClawClientOptions {
  /** WebSocket URL of the OpenClaw gateway (default: ws://127.0.0.1:18789) */
  url: string;
  /** Gateway auth token (if configured) */
  token?: string;
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean;
}

/** Presence entry from the gateway */
export interface PresenceEntry {
  agentId: string;
  sessionKey: string;
  status: 'online' | 'offline';
}

// ── Agent Map Types ─────────────────────────────────────────────────

/** Mapping between an OpenClaw agent and a Relaycast agent identity */
export interface AgentMapping {
  openclawId: string;
  relaycastName: string;
  sessionKey: string;
}

// ── Adapter Types ───────────────────────────────────────────────────

/** Configuration for the OpenClaw adapter */
export interface OpenClawAdapterOptions {
  /** WebSocket URL of the OpenClaw gateway (default: ws://127.0.0.1:18789) */
  gatewayUrl: string;
  /** Gateway auth token (optional) */
  gatewayToken?: string;

  /** Relaycast workspace API key (rk_live_xxx) */
  workspaceKey: string;
  /** Relaycast API base URL (default: https://api.relaycast.dev) */
  relaycastBaseUrl?: string;

  /** Dedicated Relaycast channel for OpenClaw agents (default: "openclaw") */
  channel?: string;
  /** Agent name prefix in Relaycast (default: "oc") */
  prefix?: string;
  /** Agent discovery poll interval in ms (default: 30000) */
  syncIntervalMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}
