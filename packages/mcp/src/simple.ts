/**
 * Simple Programmatic API for Agent Relay MCP Tools
 *
 * Dead simple access to relay tools without MCP protocol overhead.
 *
 * @example
 * ```typescript
 * import { createTools } from '@agent-relay/mcp/simple';
 *
 * const tools = await createTools('MyAgent');
 *
 * await tools.send('Bob', 'Hello!');
 * const messages = await tools.inbox();
 * const agents = await tools.who();
 * ```
 */

import { createRelayClient, type RelayClient, type RelayClientOptions } from './client.js';
import type { AckPayload } from '@agent-relay/protocol';

export interface Message {
  id: string;
  from: string;
  content: string;
  channel?: string;
  thread?: string;
}

export interface Agent {
  name: string;
  cli?: string;
  idle?: boolean;
  parent?: string;
}

export interface Status {
  connected: boolean;
  agentName: string;
  project: string;
  socketPath: string;
  daemonVersion?: string;
  uptime?: string;
}

export interface SpawnResult {
  success: boolean;
  error?: string;
}

export interface RelayTools {
  /** Send a message to an agent, channel, or broadcast */
  send(to: string, message: string, options?: { thread?: string }): Promise<void>;

  /** Send a message and wait for acknowledgment */
  sendAndWait(
    to: string,
    message: string,
    options?: { thread?: string; timeoutMs?: number }
  ): Promise<AckPayload>;

  /** Check inbox for messages */
  inbox(options?: {
    limit?: number;
    unread_only?: boolean;
    from?: string;
    channel?: string;
  }): Promise<Message[]>;

  /** List online agents */
  who(options?: { include_idle?: boolean }): Promise<Agent[]>;

  /** Spawn a worker agent */
  spawn(options: {
    name: string;
    cli: 'claude' | 'codex' | 'gemini' | 'droid' | 'opencode';
    task: string;
    model?: string;
    cwd?: string;
  }): Promise<SpawnResult>;

  /** Release a worker agent */
  release(name: string, reason?: string): Promise<SpawnResult>;

  /** Get connection status */
  status(): Promise<Status>;

  /** The underlying client (for advanced use) */
  readonly client: RelayClient;
}

export interface ToolsConfig {
  /** Socket path for daemon connection */
  socketPath?: string;
  /** Project name */
  project?: string;
  /** Request timeout in ms (default: 5000) */
  timeout?: number;
}

/**
 * Create relay tools for programmatic use.
 *
 * @example Basic Usage
 * ```typescript
 * const tools = await createTools('MyAgent');
 *
 * // Send messages
 * await tools.send('OtherAgent', 'Hello!');
 * await tools.send('#general', 'Channel message');
 * await tools.send('*', 'Broadcast to everyone');
 *
 * // Check inbox
 * const messages = await tools.inbox();
 * for (const msg of messages) {
 *   console.log(`${msg.from}: ${msg.content}`);
 * }
 *
 * // List agents
 * const agents = await tools.who();
 * console.log('Online:', agents.map(a => a.name).join(', '));
 * ```
 *
 * @example Spawn Workers
 * ```typescript
 * const tools = await createTools('Lead');
 *
 * // Spawn a worker
 * const result = await tools.spawn({
 *   name: 'Worker1',
 *   cli: 'claude',
 *   task: 'Run the test suite',
 * });
 *
 * // Release when done
 * await tools.release('Worker1', 'Tests complete');
 * ```
 */
export function createTools(agentName: string, config: ToolsConfig = {}): RelayTools {
  const client = createRelayClient({
    agentName,
    socketPath: config.socketPath,
    project: config.project,
    timeout: config.timeout,
  });

  return {
    send: (to, message, options) => client.send(to, message, options),
    sendAndWait: (to, message, options) => client.sendAndWait(to, message, options),
    inbox: (options) => client.getInbox(options),
    who: (options) => client.listAgents(options),
    spawn: (options) => client.spawn(options),
    release: (name, reason) => client.release(name, reason),
    status: () => client.getStatus(),
    get client() {
      return client;
    },
  };
}

/**
 * Convenience function for one-off messages.
 *
 * @example
 * ```typescript
 * import { send } from '@agent-relay/mcp/simple';
 *
 * await send('MyAgent', 'Bob', 'Hello!');
 * ```
 */
export async function send(
  fromAgent: string,
  to: string,
  message: string,
  options?: { thread?: string } & ToolsConfig
): Promise<void> {
  const tools = createTools(fromAgent, options);
  await tools.send(to, message, { thread: options?.thread });
}

/**
 * Convenience function to check inbox.
 *
 * @example
 * ```typescript
 * import { inbox } from '@agent-relay/mcp/simple';
 *
 * const messages = await inbox('MyAgent');
 * ```
 */
export async function inbox(
  agentName: string,
  options?: { limit?: number; unread_only?: boolean; from?: string; channel?: string } & ToolsConfig
): Promise<Message[]> {
  const tools = createTools(agentName, options);
  return tools.inbox(options);
}

/**
 * Convenience function to list agents.
 *
 * @example
 * ```typescript
 * import { who } from '@agent-relay/mcp/simple';
 *
 * const agents = await who();
 * ```
 */
export async function who(options?: { include_idle?: boolean } & ToolsConfig): Promise<Agent[]> {
  const tools = createTools('_query', options);
  return tools.who(options);
}

// Re-export client for advanced use
export { createRelayClient, type RelayClient, type RelayClientOptions };
