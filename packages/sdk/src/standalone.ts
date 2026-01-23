/**
 * Standalone Relay - Dead Simple Agent Communication
 *
 * Use Agent Relay as a pure communication layer without any external setup.
 * Just import and go.
 *
 * @example
 * ```typescript
 * import { createRelay } from '@agent-relay/sdk/standalone';
 *
 * const relay = await createRelay();
 *
 * const alice = await relay.client('Alice');
 * const bob = await relay.client('Bob');
 *
 * bob.onMessage = (from, { body }) => console.log(`${from}: ${body}`);
 * alice.sendMessage('Bob', 'Hello!');
 *
 * await relay.stop();
 * ```
 */

import { RelayClient, type ClientConfig } from './client.js';

// Types for the daemon (avoid importing to keep this file lightweight)
interface DaemonLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning: boolean;
}

export interface RelayConfig {
  /** Socket path for IPC. Default: /tmp/agent-relay-standalone.sock */
  socketPath?: string;
  /** Suppress console logging. Default: true */
  quiet?: boolean;
}

export interface Relay {
  /** Create a connected client for an agent */
  client(name: string, config?: Partial<ClientConfig>): Promise<RelayClient>;
  /** Stop the relay and disconnect all clients */
  stop(): Promise<void>;
  /** Check if relay is running */
  readonly isRunning: boolean;
  /** The socket path being used */
  readonly socketPath: string;
}

const DEFAULT_SOCKET_PATH = '/tmp/agent-relay-standalone.sock';

/**
 * Create a standalone relay for pure agent-to-agent communication.
 *
 * This starts an in-process daemon - no external setup required.
 * Perfect for using Agent Relay as just a communication layer.
 *
 * @example Basic Usage
 * ```typescript
 * const relay = await createRelay();
 *
 * const agent1 = await relay.client('Agent1');
 * const agent2 = await relay.client('Agent2');
 *
 * agent2.onMessage = (from, payload) => {
 *   console.log(`Message from ${from}: ${payload.body}`);
 * };
 *
 * agent1.sendMessage('Agent2', 'Hello!');
 * ```
 *
 * @example With Custom Socket
 * ```typescript
 * const relay = await createRelay({ socketPath: '/tmp/my-relay.sock' });
 * ```
 */
export async function createRelay(config: RelayConfig = {}): Promise<Relay> {
  const socketPath = config.socketPath ?? DEFAULT_SOCKET_PATH;
  const quiet = config.quiet ?? true;

  // Lazy-load daemon to keep SDK lightweight for client-only users
  let Daemon: new (config: Record<string, unknown>) => DaemonLike;
  try {
    const daemonModule = await import('@agent-relay/daemon');
    Daemon = daemonModule.Daemon;
  } catch {
    throw new Error(
      'To use standalone relay, install @agent-relay/daemon:\n' +
      '  npm install @agent-relay/daemon\n\n' +
      'Or if you have an external daemon running, use RelayClient directly.'
    );
  }

  const daemon = new Daemon({
    socketPath,
    consensus: false, // Minimal mode - just messaging
    cloudSync: false, // No cloud features
  });

  await daemon.start();

  const clients: RelayClient[] = [];

  return {
    async client(name: string, clientConfig: Partial<ClientConfig> = {}): Promise<RelayClient> {
      const client = new RelayClient({
        agentName: name,
        socketPath,
        quiet,
        reconnect: true,
        ...clientConfig,
      });
      await client.connect();
      clients.push(client);
      return client;
    },

    async stop(): Promise<void> {
      // Disconnect all clients first
      for (const client of clients) {
        client.destroy();
      }
      clients.length = 0;
      // Stop the daemon
      await daemon.stop();
    },

    get isRunning(): boolean {
      return daemon.isRunning;
    },

    get socketPath(): string {
      return socketPath;
    },
  };
}

/**
 * Quick helper to create two connected agents for simple communication.
 *
 * @example
 * ```typescript
 * const { alice, bob, stop } = await createPair('Alice', 'Bob');
 *
 * bob.onMessage = (from, { body }) => console.log(`${from}: ${body}`);
 * alice.sendMessage('Bob', 'Hi there!');
 *
 * await stop();
 * ```
 */
export async function createPair(
  name1: string,
  name2: string,
  config: RelayConfig = {}
): Promise<{
  [K in typeof name1]: RelayClient;
} & {
  [K in typeof name2]: RelayClient;
} & {
  relay: Relay;
  stop: () => Promise<void>;
}> {
  const relay = await createRelay(config);
  const client1 = await relay.client(name1);
  const client2 = await relay.client(name2);

  return {
    [name1]: client1,
    [name2]: client2,
    relay,
    stop: () => relay.stop(),
  } as any;
}

// Re-export client for convenience
export { RelayClient, type ClientConfig } from './client.js';
