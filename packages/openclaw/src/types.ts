/** Default port for the local OpenClaw gateway WebSocket API. */
export const DEFAULT_OPENCLAW_GATEWAY_PORT = 18789;

export interface GatewayPollFallbackProbeConfig {
  /** Whether background WS recovery probes should run while polling. */
  enabled?: boolean;
  /** How often to attempt WS recovery probes. */
  intervalMs?: number;
  /** How long WS must stay healthy before promotion back to WS. */
  stableGraceMs?: number;
}

export interface GatewayPollFallbackConfig {
  /** Enable HTTP long-poll fallback when Relaycast WS is unhealthy. */
  enabled?: boolean;
  /** Consecutive WS failures before switching to poll mode. */
  wsFailureThreshold?: number;
  /** Long-poll wait time in seconds. */
  timeoutSeconds?: number;
  /** Maximum events to request per poll. */
  limit?: number;
  /** Initial cursor used when no persisted cursor exists yet. */
  initialCursor?: string;
  /** Background WS recovery probe settings. */
  probeWs?: GatewayPollFallbackProbeConfig;
}

export interface GatewayTransportConfig {
  /** WS -> HTTP long-poll fallback settings for inbound Relaycast events. */
  pollFallback?: GatewayPollFallbackConfig;
}

export interface GatewayConfig {
  /** Relaycast workspace API key (rk_live_*). */
  apiKey: string;
  /** Name for this claw in the Relaycast workspace. */
  clawName: string;
  /** Relaycast API base URL (default: https://api.relaycast.dev). */
  baseUrl: string;
  /** Channels to auto-join on connect. */
  channels: string[];
  /** OpenClaw gateway token for authenticating with the local gateway API. */
  openclawGatewayToken?: string;
  /** OpenClaw gateway port (default: 18789). */
  openclawGatewayPort?: number;
  /** Optional inbound transport tuning. */
  transport?: GatewayTransportConfig;
}

export interface InboundMessage {
  /** Relaycast message ID. */
  id: string;
  /** Channel the message was posted to. Synthetic for DMs (e.g. "dm", "groupdm:{id}"). */
  channel: string;
  /** Agent name of the sender. */
  from: string;
  /** Message body text. */
  text: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Parent message ID when this is a thread reply. */
  threadParentId?: string;
  /** Conversation ID for DMs / group DMs. */
  conversationId?: string;
  /** Message kind hint for formatting. */
  kind?: 'channel' | 'thread' | 'dm' | 'groupdm' | 'command' | 'reaction';
}

/**
 * A stored workspace entry for multi-workspace support.
 * Matches the broker's WorkspaceSource schema in src/auth.rs.
 */
export interface WorkspaceEntry {
  /** Workspace API key (rk_live_*). */
  api_key: string;
  /** Optional workspace ID (ws_*). */
  workspace_id?: string;
  /** Human-friendly alias for this workspace. */
  workspace_alias?: string;
  /** Whether this is the default/active workspace. */
  is_default?: boolean;
}

/**
 * Multi-workspace config stored at ~/.openclaw/workspace/relaycast/workspaces.json.
 */
export interface WorkspacesConfig {
  /** All configured workspace entries. */
  workspaces: WorkspaceEntry[];
  /** Canonical workspace_id of the default workspace. */
  default_workspace_id?: string;
  /** Legacy alias-preferred selector retained only for migration on load. */
  default_workspace?: string;
}

export interface DeliveryResult {
  /** Whether delivery succeeded. */
  ok: boolean;
  /** Which method delivered: 'relay_sdk' | 'gateway_ws' | 'failed'. */
  method: 'relay_sdk' | 'gateway_ws' | 'failed';
  /** Error message if failed. */
  error?: string;
}
