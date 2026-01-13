/**
 * Type definitions for Slack Bridge
 */

export interface BridgeConfig {
  name: string;
  slackBotToken: string;
  slackAppToken: string;
  defaultChannel: string;
  socketPath?: string;
}

export interface SlackMessage {
  type: string;
  channel: string;
  user: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
}

export interface RelayMessage {
  from: string;
  body: string;
  data?: {
    source?: string;
    slackChannel?: string;
    slackThread?: string;
    [key: string]: unknown;
  };
}
