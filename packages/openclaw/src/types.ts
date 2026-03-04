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

export interface DeliveryResult {
  /** Whether delivery succeeded. */
  ok: boolean;
  /** Which method delivered: 'relay_sdk' | 'gateway_ws' | 'failed'. */
  method: 'relay_sdk' | 'gateway_ws' | 'failed';
  /** Error message if failed. */
  error?: string;
}
