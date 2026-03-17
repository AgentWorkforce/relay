export const DEFAULT_RELAY_BASE_URL = 'https://api.relaycast.dev';

/** An incoming relay message. All fields except `sender` and `text` are optional. */
export interface Message {
  readonly sender: string;
  readonly text: string;
  readonly channel?: string;
  readonly threadId?: string;
  readonly timestamp?: number;
  readonly messageId?: string;
}

/** Callback invoked when a message is received. */
export type MessageCallback = (message: Message) => void | Promise<void>;

/** User-supplied relay configuration. All fields are optional and fall back to env vars or defaults. */
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

/** Strip trailing slashes without a quantified regex (avoids ReDoS). */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * Resolve a partial config into a fully-populated config with env-var fallbacks.
 * @param config - Partial user config.
 * @returns Resolved config with all defaults applied.
 */
export function resolveRelayConfig(config: RelayConfig = {}): ResolvedRelayConfig {
  return {
    workspace: config.workspace ?? process.env.RELAY_WORKSPACE,
    apiKey: config.apiKey ?? process.env.RELAY_API_KEY,
    baseUrl: trimTrailingSlashes(config.baseUrl ?? process.env.RELAY_BASE_URL ?? DEFAULT_RELAY_BASE_URL),
    channels: [...(config.channels ?? ['general'])],
    pollIntervalMs: config.pollIntervalMs ?? 1_000,
    autoCleanup: config.autoCleanup ?? true,
  };
}

/**
 * Format a single message for display in agent instructions.
 * @param message - The relay message to format.
 * @returns Human-readable message string.
 */
export function formatRelayMessage(message: Message): string {
  const location = message.channel ? ` [#${message.channel}]` : '';
  const thread = message.threadId ? ` [thread ${message.threadId}]` : '';
  return `Relay message from ${message.sender}${location}${thread}: ${message.text}`;
}

/**
 * Format an array of messages for display in agent instructions.
 * @param messages - The relay messages to format.
 * @returns Human-readable inbox summary.
 */
export function formatRelayInbox(messages: Message[]): string {
  if (messages.length === 0) {
    return 'No new relay messages.';
  }

  return messages.map((message) => formatRelayMessage(message)).join('\n');
}
