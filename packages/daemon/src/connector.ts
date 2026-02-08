/**
 * Connector — lightweight local bridge to a hosted daemon.
 *
 * Replaces the entire local daemon + relay-pty setup with a single process
 * that bridges the file-based outbox protocol to a hosted WebSocket daemon.
 *
 * One command to start:
 *   relay connect wss://your-host/ws
 *
 * What it does:
 *   1. Connects to the hosted daemon via WebSocket as a named agent
 *   2. Watches the local outbox directory for file-based messages
 *   3. Parses outbox files (TO/KIND/THREAD header format) and sends them
 *      to the hosted daemon via the relay protocol
 *   4. Receives messages from the hosted daemon and writes them to the
 *      local inbox directory for agents to read
 *   5. Optionally spawns agents using the bridge/spawner packages
 *
 * This means agents that use the file-based outbox (->relay-file:msg)
 * work without any code changes — just point to a hosted daemon URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { watch, type FSWatcher } from 'node:fs';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  type Envelope,
  type HelloPayload,
  type WelcomePayload,
  type SendPayload,
  type DeliverEnvelope,
  type PongPayload,
} from '@agent-relay/protocol/types';
import { randomUUID } from 'node:crypto';

/** Generate a short unique ID */
function generateId(): string {
  return randomUUID().replace(/-/g, '').substring(0, 16);
}

export interface ConnectorConfig {
  /** WebSocket URL of the hosted daemon (e.g. wss://your-host/ws) */
  url: string;
  /** Agent name for this connector (default: auto-generated) */
  agentName?: string;
  /** Workspace token for authentication */
  token?: string;
  /** Outbox directory to watch (default: auto-detect) */
  outboxDir?: string;
  /** Inbox directory for received messages (default: auto-detect) */
  inboxDir?: string;
  /** Whether to reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** CLI name for the HELLO payload */
  cli?: string;
  /** Task description */
  task?: string;
}

type ConnectorState = 'disconnected' | 'connecting' | 'handshaking' | 'connected' | 'closed';

/**
 * Parse a header-format outbox file.
 *
 * Format:
 *   TO: AgentName
 *   KIND: message|spawn|release
 *   THREAD: optional-thread
 *
 *   Body content here
 */
function parseOutboxFile(content: string): {
  to?: string;
  kind?: string;
  name?: string;
  cli?: string;
  thread?: string;
  action?: string;
  body: string;
} | null {
  // Split at first blank line
  const blankLineIdx = content.indexOf('\n\n');
  let headerSection: string;
  let body: string;

  if (blankLineIdx === -1) {
    // No blank line — treat entire content as headers (no body)
    headerSection = content;
    body = '';
  } else {
    headerSection = content.substring(0, blankLineIdx);
    body = content.substring(blankLineIdx + 2);
  }

  const headers: Record<string, string> = {};
  for (const line of headerSection.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim().toUpperCase();
    const value = line.substring(colonIdx + 1).trim();
    if (key && value) {
      headers[key] = value;
    }
  }

  // Must have TO or KIND header to be valid
  if (!headers['TO'] && !headers['KIND']) {
    // Try JSON fallback
    try {
      const json = JSON.parse(content);
      return {
        to: json.to,
        kind: json.kind ?? 'message',
        name: json.name,
        cli: json.cli,
        thread: json.thread,
        body: json.body ?? '',
      };
    } catch {
      return null;
    }
  }

  return {
    to: headers['TO'],
    kind: headers['KIND'] ?? 'message',
    name: headers['NAME'],
    cli: headers['CLI'],
    thread: headers['THREAD'],
    action: headers['ACTION'],
    body: body.trim(),
  };
}

export class Connector {
  private config: ConnectorConfig;
  private ws?: WebSocket;
  private state: ConnectorState = 'disconnected';
  private sessionId?: string;
  private resumeToken?: string;
  private reconnectDelay = 1000;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private outboxWatcher?: FSWatcher;
  private outboxDir: string;
  private inboxDir: string;
  private agentName: string;
  private pendingFiles: Set<string> = new Set();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  /** Callback for received messages */
  onMessage?: (from: string, body: string, envelope: Envelope) => void;
  /** Callback for state changes */
  onStateChange?: (state: ConnectorState) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;

  constructor(config: ConnectorConfig) {
    this.config = {
      autoReconnect: true,
      maxReconnectDelay: 30000,
      ...config,
    };

    this.agentName = config.agentName ?? `connector-${generateId().substring(0, 6)}`;

    // Determine outbox directory
    if (config.outboxDir) {
      this.outboxDir = config.outboxDir;
    } else if (process.env.AGENT_RELAY_OUTBOX) {
      this.outboxDir = process.env.AGENT_RELAY_OUTBOX;
    } else {
      const workspaceId = process.env.RELAY_WORKSPACE_ID
        || process.env.AGENT_RELAY_WORKSPACE_ID
        || process.env.WORKSPACE_ID;
      if (workspaceId) {
        this.outboxDir = `/tmp/relay/${workspaceId}/outbox/${this.agentName}`;
      } else {
        this.outboxDir = path.join(os.homedir(), '.agent-relay', 'outbox', this.agentName);
      }
    }

    // Determine inbox directory
    if (config.inboxDir) {
      this.inboxDir = config.inboxDir;
    } else {
      this.inboxDir = path.join(path.dirname(this.outboxDir), '..', 'inbox', this.agentName);
    }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * Start the connector:
   * 1. Connect to the hosted daemon via WebSocket
   * 2. Start watching the outbox directory
   * 3. Return when connected and ready
   */
  async start(): Promise<void> {
    // Ensure directories exist
    fs.mkdirSync(this.outboxDir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });

    // Connect to hosted daemon
    await this.connect();

    // Start watching outbox
    this.startOutboxWatcher();

    // Process any existing outbox files
    this.processExistingOutboxFiles();

    console.log(`[connector] Outbox: ${this.outboxDir}`);
    console.log(`[connector] Inbox:  ${this.inboxDir}`);
  }

  /**
   * Stop the connector and clean up.
   */
  stop(): void {
    this.state = 'closed';
    this.onStateChange?.('closed');

    // Stop reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    // Stop debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Stop outbox watcher
    if (this.outboxWatcher) {
      this.outboxWatcher.close();
      this.outboxWatcher = undefined;
    }

    // Close WebSocket
    if (this.ws) {
      try {
        // Send BYE
        this.sendEnvelope({
          v: PROTOCOL_VERSION,
          type: 'BYE',
          id: generateId(),
          ts: Date.now(),
          payload: {},
        });
      } catch {}
      this.ws.close();
      this.ws = undefined;
    }
  }

  get connected(): boolean {
    return this.state === 'connected';
  }

  get outboxPath(): string {
    return this.outboxDir;
  }

  get inboxPath(): string {
    return this.inboxDir;
  }

  get name(): string {
    return this.agentName;
  }

  // ─── WebSocket Connection ─────────────────────────────────────────

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = 'connecting';
      this.onStateChange?.('connecting');

      // Build URL with optional token
      let url = this.config.url;
      if (this.config.token) {
        const separator = url.includes('?') ? '&' : '?';
        url = `${url}${separator}token=${this.config.token}`;
      }

      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        if (this.state === 'connecting' || this.state === 'handshaking') {
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        this.state = 'handshaking';
        this.onStateChange?.('handshaking');
        this.reconnectDelay = 1000; // Reset on successful connect

        // Send HELLO
        const hello: Envelope<HelloPayload> = {
          v: PROTOCOL_VERSION,
          type: 'HELLO',
          id: generateId(),
          ts: Date.now(),
          payload: {
            agent: this.agentName,
            capabilities: { ack: true, resume: true, max_inflight: 100, supports_topics: true },
            cli: this.config.cli ?? 'connector',
            task: this.config.task,
            ...(this.resumeToken ? { session: { resume_token: this.resumeToken } } : {}),
          },
        };
        this.sendEnvelope(hello);
      });

      this.ws.on('message', (data) => {
        const msg = typeof data === 'string' ? data : data.toString('utf-8');
        try {
          const envelope = JSON.parse(msg) as Envelope;
          this.handleEnvelope(envelope, resolve, clearTimeout.bind(null, timeout));
        } catch (err) {
          console.error('[connector] Invalid message from server:', err);
        }
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        const wasConnected = this.state === 'connected';
        if (this.state !== 'closed') {
          this.state = 'disconnected';
          this.onStateChange?.('disconnected');
        }

        if (wasConnected && this.config.autoReconnect && this.state !== 'closed') {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (this.state === 'connecting' || this.state === 'handshaking') {
          reject(err);
        }
        this.onError?.(err);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.state === 'closed') return;

    console.log(`[connector] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        console.log('[connector] Reconnected');
      } catch (err) {
        console.error('[connector] Reconnect failed:', (err as Error).message);
        // Exponential backoff
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.config.maxReconnectDelay ?? 30000
        );
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private handleEnvelope(
    envelope: Envelope,
    onFirstWelcome?: (value: void) => void,
    clearConnTimeout?: () => void
  ): void {
    switch (envelope.type) {
      case 'WELCOME': {
        const welcome = envelope as Envelope<WelcomePayload>;
        this.sessionId = welcome.payload.session_id;
        this.resumeToken = welcome.payload.resume_token;
        this.state = 'connected';
        this.onStateChange?.('connected');
        clearConnTimeout?.();
        onFirstWelcome?.();
        console.log(`[connector] Connected as "${this.agentName}" (session: ${this.sessionId})`);
        break;
      }

      case 'DELIVER': {
        const deliver = envelope as DeliverEnvelope;
        const from = deliver.from ?? 'unknown';
        const body = deliver.payload?.body ?? '';

        // Write to inbox file for local agents to read
        this.writeInboxMessage(from, body, deliver);

        // Fire callback
        this.onMessage?.(from, body, deliver);

        // Send ACK
        this.sendEnvelope({
          v: PROTOCOL_VERSION,
          type: 'ACK',
          id: generateId(),
          ts: Date.now(),
          from: this.agentName,
          to: from,
          payload: {
            ack_id: deliver.id,
          },
        });
        break;
      }

      case 'PING': {
        // Respond with PONG
        this.sendEnvelope({
          v: PROTOCOL_VERSION,
          type: 'PONG',
          id: generateId(),
          ts: Date.now(),
          payload: {
            nonce: (envelope.payload as { nonce?: string })?.nonce ?? '',
          },
        });
        break;
      }

      case 'ERROR': {
        const errPayload = envelope.payload as { message?: string; fatal?: boolean };
        console.error(`[connector] Server error: ${errPayload.message}`);
        if (errPayload.fatal) {
          this.stop();
        }
        break;
      }

      case 'AGENT_READY': {
        // Log when other agents come online
        const payload = envelope.payload as { name?: string };
        if (payload.name) {
          console.log(`[connector] Agent ready: ${payload.name}`);
        }
        break;
      }

      default:
        // Ignore other envelope types
        break;
    }
  }

  // ─── Outbound (Outbox → Hosted Daemon) ────────────────────────────

  private sendEnvelope(envelope: Envelope): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a message to a specific agent via the hosted daemon.
   */
  sendMessage(to: string, body: string, options?: { thread?: string; kind?: string }): boolean {
    const envelope: Envelope<SendPayload> = {
      v: PROTOCOL_VERSION,
      type: 'SEND',
      id: generateId(),
      ts: Date.now(),
      from: this.agentName,
      to,
      payload: {
        kind: (options?.kind as SendPayload['kind']) ?? 'message',
        body,
        thread: options?.thread,
      },
    };
    return this.sendEnvelope(envelope);
  }

  // ─── Outbox Watcher ───────────────────────────────────────────────

  private startOutboxWatcher(): void {
    try {
      this.outboxWatcher = watch(this.outboxDir, (eventType, filename) => {
        if (!filename) return;

        // Debounce: wait 100ms after the last event for this file
        const existing = this.debounceTimers.get(filename);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(filename, setTimeout(() => {
          this.debounceTimers.delete(filename);
          this.processOutboxFile(filename);
        }, 100));
      });
    } catch (err) {
      console.error('[connector] Failed to watch outbox:', (err as Error).message);
    }
  }

  private processExistingOutboxFiles(): void {
    try {
      const files = fs.readdirSync(this.outboxDir);
      for (const file of files) {
        this.processOutboxFile(file);
      }
    } catch {
      // Directory might not exist yet, that's ok
    }
  }

  private processOutboxFile(filename: string): void {
    // Skip hidden files, temp files
    if (filename.startsWith('.') || filename.endsWith('.tmp')) return;
    // Skip already-processed files
    if (this.pendingFiles.has(filename)) return;

    const filePath = path.join(this.outboxDir, filename);

    // Check if file exists (may have been deleted already)
    if (!fs.existsSync(filePath)) return;

    this.pendingFiles.add(filename);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseOutboxFile(content);

      if (!parsed) {
        console.warn(`[connector] Could not parse outbox file: ${filename}`);
        this.pendingFiles.delete(filename);
        return;
      }

      // Handle different message kinds
      switch (parsed.kind) {
        case 'spawn': {
          // Forward spawn request to hosted daemon
          if (parsed.name && parsed.cli) {
            this.sendEnvelope({
              v: PROTOCOL_VERSION,
              type: 'SPAWN',
              id: generateId(),
              ts: Date.now(),
              from: this.agentName,
              payload: {
                name: parsed.name,
                cli: parsed.cli,
                task: parsed.body,
              },
            });
          }
          break;
        }

        case 'release': {
          if (parsed.name) {
            this.sendEnvelope({
              v: PROTOCOL_VERSION,
              type: 'RELEASE',
              id: generateId(),
              ts: Date.now(),
              from: this.agentName,
              payload: {
                name: parsed.name,
                reason: parsed.body || 'Released by connector',
              },
            });
          }
          break;
        }

        case 'continuity': {
          // Handle continuity saves/loads as metadata messages
          if (parsed.action === 'save' && parsed.body) {
            this.sendMessage('_system', parsed.body, { kind: 'state' });
          }
          break;
        }

        default: {
          // Regular message
          const to = parsed.to;
          if (to) {
            this.sendMessage(to, parsed.body, { thread: parsed.thread, kind: parsed.kind });
          }
          break;
        }
      }

      // Delete the file after processing (same as relay-pty behavior)
      try {
        fs.unlinkSync(filePath);
      } catch {
        // File may already be deleted
      }
    } catch (err) {
      console.error(`[connector] Error processing outbox file ${filename}:`, (err as Error).message);
    } finally {
      this.pendingFiles.delete(filename);
    }
  }

  // ─── Inbox Writer ─────────────────────────────────────────────────

  private writeInboxMessage(from: string, body: string, envelope: DeliverEnvelope): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const msgId = envelope.id.substring(0, 8);
      const filename = `${timestamp}_${from}_${msgId}.txt`;
      const filePath = path.join(this.inboxDir, filename);

      const content = [
        `FROM: ${from}`,
        envelope.to ? `TO: ${envelope.to}` : '',
        envelope.payload?.thread ? `THREAD: ${envelope.payload.thread}` : '',
        `TIMESTAMP: ${new Date(envelope.ts).toISOString()}`,
        `ID: ${envelope.id}`,
        '',
        body,
      ].filter(Boolean).join('\n');

      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err) {
      console.error('[connector] Failed to write inbox message:', (err as Error).message);
    }
  }
}

/**
 * Start a connector with a single function call.
 * This is the simplest API for the "one command" experience.
 *
 * @param url - WebSocket URL of the hosted daemon
 * @param options - Optional configuration
 * @returns Running Connector instance
 */
export async function connect(
  url: string,
  options: Partial<ConnectorConfig> = {}
): Promise<Connector> {
  const connector = new Connector({ url, ...options });
  await connector.start();
  return connector;
}
