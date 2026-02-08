/**
 * Relaycast Injector — bridges relaycast messaging to relay-pty injection.
 *
 * This is the minimal glue between relaycast (hosted messaging) and relay-pty
 * (local PTY injection). Instead of building our own message router, we let
 * relaycast handle all messaging and just focus on pushing incoming messages
 * into the CLI's stdin via relay-pty's proven injection socket.
 *
 * Architecture:
 *   relaycast cloud ──WebSocket──► injector ──Unix socket──► relay-pty ──PTY──► claude
 *
 * How it works:
 *   1. Registers agent with relaycast API (gets agent token)
 *   2. Connects to relaycast WebSocket stream for real-time events
 *   3. On message.created / dm.received / thread.reply → inject via relay-pty socket
 *   4. Agent uses relaycast MCP tools for outbound messaging (send_dm, post_message)
 *
 * The agent's outbound flow (relaycast MCP) is entirely independent.
 * This injector only handles the inbound path.
 */

import { createConnection, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

function generateId(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

// ─── Relaycast Event Types (minimal, matching @relaycast/types) ──────

interface RelaycastMessage {
  id: string;
  agent_name: string;
  text: string;
  attachments?: { file_id: string; filename: string; url: string; size: number }[];
}

interface MessageCreatedEvent {
  type: 'message.created';
  channel: string;
  message: RelaycastMessage;
}

interface DmReceivedEvent {
  type: 'dm.received';
  conversation_id: string;
  message: RelaycastMessage;
}

interface ThreadReplyEvent {
  type: 'thread.reply';
  parent_id: string;
  message: RelaycastMessage;
}

interface AgentOnlineEvent {
  type: 'agent.online';
  agent_name: string;
}

interface AgentOfflineEvent {
  type: 'agent.offline';
  agent_name: string;
}

type InjectableEvent = MessageCreatedEvent | DmReceivedEvent | ThreadReplyEvent;

type ServerEvent = InjectableEvent | AgentOnlineEvent | AgentOfflineEvent | { type: string };

// ─── Config ──────────────────────────────────────────────────────────

export interface RelaycastInjectorConfig {
  /** Relaycast API base URL (default: https://api.relaycast.dev) */
  apiUrl?: string;
  /** Workspace API key (rk_live_...) for agent registration */
  apiKey: string;
  /** Agent name to register */
  agentName: string;
  /** Pre-existing agent token (skips registration if provided) */
  agentToken?: string;
  /** relay-pty injection socket path */
  socketPath: string;
  /** Channels to auto-subscribe to (default: ['general']) */
  channels?: string[];
  /** Enable debug logging */
  debug?: boolean;
  /** Agent persona description for registration */
  persona?: string;
}

// ─── Relaycast Injector ──────────────────────────────────────────────

export class RelaycastInjector {
  private config: RelaycastInjectorConfig;
  private apiUrl: string;
  private agentToken?: string;
  private ws?: WebSocket;
  private socket?: Socket;
  private socketConnected = false;
  private wsConnected = false;
  private stopped = false;
  private reconnectDelay = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  /** Callback when an agent comes online */
  onAgentOnline?: (name: string) => void;
  /** Callback when an agent goes offline */
  onAgentOffline?: (name: string) => void;
  /** Callback for injection events (for logging/debugging) */
  onInject?: (from: string, text: string) => void;

  constructor(config: RelaycastInjectorConfig) {
    this.config = config;
    this.apiUrl = config.apiUrl || 'https://api.relaycast.dev';
    this.agentToken = config.agentToken;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Start the injector:
   * 1. Register agent with relaycast (if no pre-existing token)
   * 2. Connect to relay-pty injection socket
   * 3. Connect to relaycast WebSocket stream
   * 4. Subscribe to channels
   */
  async start(): Promise<void> {
    // Step 1: Register agent (or use pre-existing token)
    if (!this.agentToken) {
      this.agentToken = await this.registerAgent();
      this.log(`Registered as "${this.config.agentName}" (token: ${this.agentToken.substring(0, 12)}...)`);
    } else {
      this.log(`Using pre-existing token for "${this.config.agentName}"`);
    }

    // Step 2: Connect to relay-pty injection socket
    await this.connectSocket();

    // Step 3: Connect to relaycast WebSocket
    await this.connectWebSocket();

    // Step 4: Subscribe to channels
    const channels = this.config.channels ?? ['general'];
    this.subscribeChannels(channels);

    this.log('Injector started — listening for messages');
  }

  /**
   * Stop the injector and clean up.
   */
  stop(): void {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
  }

  get isConnected(): boolean {
    return this.wsConnected && this.socketConnected;
  }

  get token(): string | undefined {
    return this.agentToken;
  }

  // ─── Outbound Messaging (via relaycast API) ─────────────────────────

  /**
   * Send a direct message to another agent via relaycast API.
   * This ensures the message is persisted in relaycast for memory/billing.
   */
  async sendDm(to: string, text: string): Promise<boolean> {
    if (!this.agentToken) {
      this.log('Cannot send DM: no agent token');
      return false;
    }

    try {
      const url = `${this.apiUrl}/v1/dms/send`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.agentToken}`,
        },
        body: JSON.stringify({ to, text }),
      });

      if (!response.ok) {
        const body = await response.text();
        this.log(`sendDm failed: ${response.status} ${body}`);
        return false;
      }

      this.log(`DM sent to ${to} (${text.length}B)`);
      return true;
    } catch (err) {
      this.log(`sendDm error: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Post a message to a channel via relaycast API.
   * This ensures the message is persisted in relaycast for memory/billing.
   */
  async postMessage(channel: string, text: string, thread?: string): Promise<boolean> {
    if (!this.agentToken) {
      this.log('Cannot post message: no agent token');
      return false;
    }

    try {
      const url = `${this.apiUrl}/v1/channels/${encodeURIComponent(channel)}/messages`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.agentToken}`,
        },
        body: JSON.stringify({ text, ...(thread ? { thread_id: thread } : {}) }),
      });

      if (!response.ok) {
        const body = await response.text();
        this.log(`postMessage failed: ${response.status} ${body}`);
        return false;
      }

      this.log(`Message posted to #${channel} (${text.length}B)`);
      return true;
    } catch (err) {
      this.log(`postMessage error: ${(err as Error).message}`);
      return false;
    }
  }

  // ─── Relaycast API ─────────────────────────────────────────────────

  /**
   * Register agent with relaycast and get an agent token.
   */
  private async registerAgent(): Promise<string> {
    const url = `${this.apiUrl}/v1/agents`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        name: this.config.agentName,
        type: 'agent',
        persona: this.config.persona ?? `CLI agent: ${this.config.agentName}`,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to register agent: ${response.status} ${body}`);
    }

    const data = await response.json() as { token?: string; agent_token?: string };
    const token = data.token || data.agent_token;
    if (!token) {
      throw new Error('Registration response missing agent token');
    }

    return token;
  }

  // ─── Relaycast WebSocket ───────────────────────────────────────────

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.apiUrl.replace(/^http/, 'ws')}/v1/stream?token=${encodeURIComponent(this.agentToken!)}`;
      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        this.ws?.close();
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.wsConnected = true;
        this.reconnectDelay = 1000;
        this.log('Connected to relaycast WebSocket');
        resolve();
      });

      this.ws.on('message', (data) => {
        const raw = typeof data === 'string' ? data : data.toString('utf-8');
        try {
          const event = JSON.parse(raw) as ServerEvent;
          this.handleEvent(event);
        } catch {
          // Ignore malformed events
        }
      });

      this.ws.on('close', () => {
        this.wsConnected = false;
        if (!this.stopped) {
          this.log('WebSocket disconnected, reconnecting...');
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (!this.wsConnected) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connectWebSocket();
        // Re-subscribe to channels
        const channels = this.config.channels ?? ['general'];
        this.subscribeChannels(channels);
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private subscribeChannels(channels: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      type: 'subscribe',
      channels,
    }));
    this.log(`Subscribed to channels: ${channels.join(', ')}`);
  }

  // ─── Event Handling ────────────────────────────────────────────────

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'message.created': {
        const e = event as MessageCreatedEvent;
        // Don't inject our own messages
        if (e.message.agent_name === this.config.agentName) return;
        this.inject(
          e.message.agent_name,
          e.message.text,
          e.message.id,
          `#${e.channel}`
        );
        break;
      }

      case 'dm.received': {
        const e = event as DmReceivedEvent;
        if (e.message.agent_name === this.config.agentName) return;
        this.inject(
          e.message.agent_name,
          e.message.text,
          e.message.id
        );
        break;
      }

      case 'thread.reply': {
        const e = event as ThreadReplyEvent;
        if (e.message.agent_name === this.config.agentName) return;
        this.inject(
          e.message.agent_name,
          e.message.text,
          e.message.id,
          undefined,
          e.parent_id
        );
        break;
      }

      case 'agent.online': {
        const e = event as AgentOnlineEvent;
        this.log(`Agent online: ${e.agent_name}`);
        this.onAgentOnline?.(e.agent_name);
        break;
      }

      case 'agent.offline': {
        const e = event as AgentOfflineEvent;
        this.log(`Agent offline: ${e.agent_name}`);
        this.onAgentOffline?.(e.agent_name);
        break;
      }

      case 'pong':
        break;

      default:
        this.log(`Unhandled event: ${event.type}`);
    }
  }

  // ─── Injection via relay-pty Socket ────────────────────────────────

  /**
   * Connect to relay-pty's Unix socket for message injection.
   * Retries with backoff since relay-pty takes a moment to create the socket.
   */
  private async connectSocket(attempt = 0): Promise<void> {
    const MAX_ATTEMPTS = 20;
    const BASE_DELAY = 300;

    if (attempt >= MAX_ATTEMPTS) {
      this.log(`Failed to connect to relay-pty socket after ${MAX_ATTEMPTS} attempts`);
      return;
    }

    if (!existsSync(this.config.socketPath)) {
      await new Promise(resolve => setTimeout(resolve, BASE_DELAY * Math.min(attempt + 1, 5)));
      return this.connectSocket(attempt + 1);
    }

    return new Promise<void>((resolve) => {
      const socket = createConnection(this.config.socketPath);

      socket.on('connect', () => {
        this.socket = socket;
        this.socketConnected = true;
        this.log('Connected to relay-pty injection socket');
        resolve();
      });

      socket.on('data', (data) => {
        // Log injection results
        for (const line of data.toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const result = JSON.parse(line);
            if (result.type === 'inject_result') {
              this.log(`Inject ${result.id?.substring(0, 8)}: ${result.status}`);
            }
          } catch {
            // Non-JSON, ignore
          }
        }
      });

      socket.on('error', () => {
        this.socketConnected = false;
        this.socket = undefined;
        if (attempt < MAX_ATTEMPTS - 1) {
          setTimeout(() => {
            this.connectSocket(attempt + 1).then(resolve);
          }, BASE_DELAY * Math.min(attempt + 1, 5));
        } else {
          resolve();
        }
      });

      socket.on('close', () => {
        this.socketConnected = false;
        this.socket = undefined;
        // Reconnect if not stopped
        if (!this.stopped) {
          setTimeout(() => this.connectSocket(0), 1000);
        }
      });
    });
  }

  /**
   * Inject a message into the CLI via relay-pty's socket protocol.
   *
   * The relay-pty Rust binary will write the message into the PTY as:
   *   Relay message from Alice [abc12345]: Hello, can you help?
   */
  private inject(from: string, text: string, messageId: string, channel?: string, thread?: string): void {
    if (!this.socket || !this.socketConnected) {
      this.log(`Cannot inject: socket not connected`);
      return;
    }

    // Build the body with context
    let body = text;
    if (channel) {
      body = `[${channel}] ${text}`;
    }
    if (thread) {
      body = `[thread:${thread.substring(0, 8)}] ${text}`;
    }

    // relay-pty injection protocol: JSON request over Unix socket
    const request = JSON.stringify({
      type: 'inject',
      id: messageId || generateId(),
      from,
      body,
      priority: 0,
    }) + '\n';

    this.socket.write(request);
    this.onInject?.(from, text);
    this.log(`Injected: ${from} → "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}"`);
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private log(msg: string): void {
    if (this.config.debug) {
      process.stderr.write(`[relaycast-injector] ${msg}\n`);
    }
  }
}
