export interface GatewayConfig {
  /** Relaycast workspace API key (rk_live_*). */
  apiKey: string;
  /** Name for this claw in the Relaycast workspace. */
  clawName: string;
  /** Relaycast API base URL (default: https://api.relaycast.dev). */
  baseUrl: string;
  /** Channels to auto-join on connect. */
  channels: string[];
}

export interface InboundMessage {
  /** Relaycast message ID. */
  id: string;
  /** Channel the message was posted to. */
  channel: string;
  /** Agent name of the sender. */
  from: string;
  /** Message body text. */
  text: string;
  /** ISO timestamp. */
  timestamp: string;
}

export interface DeliveryResult {
  /** Whether delivery succeeded. */
  ok: boolean;
  /** Which method delivered: 'relay_sdk' | 'sessions_rpc' | 'failed'. */
  method: 'relay_sdk' | 'sessions_rpc' | 'failed';
  /** Error message if failed. */
  error?: string;
}
