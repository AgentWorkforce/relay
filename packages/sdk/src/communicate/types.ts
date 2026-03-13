export const DEFAULT_RELAY_BASE_URL = 'https://api.relaycast.dev';

export interface Message {
  sender: string;
  text: string;
  channel?: string;
  threadId?: string;
  timestamp?: number;
  messageId?: string;
}

export type MessageCallback = (message: Message) => void | Promise<void>;

export interface RelayConfig {
  workspace?: string;
  apiKey?: string;
  baseUrl?: string;
  channels?: string[];
  pollIntervalMs?: number;
  autoCleanup?: boolean;
}

export interface ResolvedRelayConfig {
  workspace?: string;
  apiKey?: string;
  baseUrl: string;
  channels: string[];
  pollIntervalMs: number;
  autoCleanup: boolean;
}

export class RelayConnectionError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`${statusCode}: ${message}`);
    this.name = 'RelayConnectionError';
    this.statusCode = statusCode;
  }
}

export class RelayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConfigError';
  }
}

export class RelayAuthError extends RelayConnectionError {
  constructor(message = 'Unauthorized', statusCode = 401) {
    super(statusCode, message);
    this.name = 'RelayAuthError';
  }
}

export function resolveRelayConfig(config: RelayConfig = {}): ResolvedRelayConfig {
  return {
    workspace: config.workspace ?? process.env.RELAY_WORKSPACE,
    apiKey: config.apiKey ?? process.env.RELAY_API_KEY,
    baseUrl: (config.baseUrl ?? process.env.RELAY_BASE_URL ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, ''),
    channels: [...(config.channels ?? ['general'])],
    pollIntervalMs: config.pollIntervalMs ?? 1_000,
    autoCleanup: config.autoCleanup ?? true,
  };
}

export function formatRelayMessage(message: Message): string {
  const location = message.channel ? ` [#${message.channel}]` : '';
  const thread = message.threadId ? ` [thread ${message.threadId}]` : '';
  return `Relay message from ${message.sender}${location}${thread}: ${message.text}`;
}

export function formatRelayInbox(messages: Message[]): string {
  if (messages.length === 0) {
    return 'No new relay messages.';
  }

  return messages.map((message) => formatRelayMessage(message)).join('\n');
}
