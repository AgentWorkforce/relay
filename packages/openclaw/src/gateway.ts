import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { SendMessageInput } from '@agent-relay/sdk';
import { RelayCast, type AgentClient } from '@relaycast/sdk';
import type {
  MessageCreatedEvent,
  ThreadReplyEvent,
  DmReceivedEvent,
  GroupDmReceivedEvent,
  CommandInvokedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from '@relaycast/sdk';
import WebSocket from 'ws';

import { DEFAULT_OPENCLAW_GATEWAY_PORT, type GatewayConfig, type InboundMessage, type DeliveryResult } from './types.js';
import { SpawnManager } from './spawn/manager.js';
import type { SpawnOptions } from './spawn/types.js';

/**
 * A minimal interface for sending messages via Agent Relay.
 * Accepts either AgentRelayClient or AgentRelay — any object with a
 * compatible sendMessage() method.
 */
export interface RelaySender {
  sendMessage(input: SendMessageInput): Promise<{ event_id: string; targets?: string[] }>;
}

export interface GatewayOptions {
  /** Gateway configuration. */
  config: GatewayConfig;
  /**
   * Pre-existing relay sender for message delivery.
   * Pass the API server's AgentRelay instance so all gateways share a single
   * broker process instead of each spawning their own.
   */
  relaySender?: RelaySender;
}

function normalizeChannelName(channel: string): string {
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

// ---------------------------------------------------------------------------
// Ed25519 device identity for OpenClaw gateway WebSocket auth
// ---------------------------------------------------------------------------

interface DeviceIdentity {
  publicKeyB64: string;    // base64url-encoded raw Ed25519 public key
  privateKeyObj: KeyObject; // Node.js KeyObject for signing
  deviceId: string;         // SHA-256 hex of the raw public key
}

function generateDeviceIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  // Extract raw 32-byte public key from SPKI DER (12-byte header for Ed25519)
  const rawPublicBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);

  const deviceId = createHash('sha256').update(rawPublicBytes).digest('hex');
  const publicKeyB64 = Buffer.from(rawPublicBytes).toString('base64url');

  return {
    publicKeyB64,
    privateKeyObj: privateKey,
    deviceId,
  };
}

function signConnectPayload(
  device: DeviceIdentity,
  params: {
    clientId: string;
    clientMode: string;
    platform: string;
    deviceFamily: string;
    role: string;
    scopes: string[];
    signedAt: number;
    token: string;
    nonce: string;
  },
): string {
  // v3 payload format: v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily
  const payload = [
    'v3',
    device.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(','),
    String(params.signedAt),
    params.token || '',
    params.nonce,
    params.platform,
    params.deviceFamily,
  ].join('|');

  const payloadBytes = Buffer.from(payload, 'utf-8');

  // Ed25519 sign — no hash algorithm needed (null), it's built into Ed25519
  const signature = sign(null, payloadBytes, device.privateKeyObj);
  return Buffer.from(signature).toString('base64url');
}


// ---------------------------------------------------------------------------
// Persistent OpenClaw Gateway WebSocket client
// ---------------------------------------------------------------------------

interface PendingRpc {
  resolve: (value: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** @internal */
export class OpenClawGatewayClient {
  private ws: WebSocket | null = null;
  private authenticated = false;
  private device: DeviceIdentity;
  private token: string;
  private port: number;
  private pendingRpcs = new Map<string, PendingRpc>();
  private rpcIdCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pairingRejected = false;
  private consecutiveFailures = 0;

  /** Default timeout for initial connection (30 seconds). */
  private static readonly CONNECT_TIMEOUT_MS = 30_000;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;
  private static readonly BASE_RECONNECT_MS = 3_000;
  private static readonly MAX_RECONNECT_MS = 30_000;

  constructor(token: string, port: number) {
    this.token = token;
    this.port = port;
    this.device = generateDeviceIdentity();
  }

  /** Connect and authenticate. Resolves when chat.send is ready, rejects on timeout or error. */
  async connect(): Promise<void> {
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) return;

    // Cancel any pending reconnect timer to prevent orphaned WebSocket connections
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      // Set up timeout to prevent indefinite hanging
      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = null;
        if (!this.authenticated) {
          const err = new Error(`Connection to OpenClaw gateway timed out after ${OpenClawGatewayClient.CONNECT_TIMEOUT_MS}ms`);
          this.connectReject?.(err);
          this.connectReject = null;
          this.connectResolve = null;
        }
      }, OpenClawGatewayClient.CONNECT_TIMEOUT_MS);
    });

    this.doConnect();
    return this.connectPromise;
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private doConnect(): void {
    if (this.stopped) return;

    try {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
    } catch (err) {
      console.warn(`[openclaw-ws] Connection failed: ${err instanceof Error ? err.message : String(err)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[openclaw-ws] Connected to OpenClaw gateway');
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('close', (code, reason) => {
      const reasonStr = reason.toString();
      console.warn(`[openclaw-ws] Disconnected: ${code} ${reasonStr}`);
      const wasAuthenticated = this.authenticated;
      this.authenticated = false;

      // Detect pairing rejection via close code 1008 (Policy Violation)
      if (code === 1008 || /pairing|not.paired/i.test(reasonStr)) {
        console.error('[openclaw-ws] Connection closed due to pairing policy. Device is not paired.');
        console.error('[openclaw-ws] Ensure OPENCLAW_GATEWAY_TOKEN matches ~/.openclaw/openclaw.json gateway.auth.token');
        this.pairingRejected = true;
      }

      // Reject all pending RPCs
      for (const [id, pending] of this.pendingRpcs) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pendingRpcs.delete(id);
      }
      // If we weren't authenticated yet, reject the connect promise
      if (!wasAuthenticated && this.connectReject) {
        this.clearConnectTimeout();
        const err = new Error(`WebSocket closed before authentication (code=${code})`);
        this.connectReject(err);
        this.connectReject = null;
        this.connectResolve = null;
      }
      if (!this.stopped && !this.pairingRejected) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.warn(`[openclaw-ws] Error: ${err.message}`);
      // If we weren't authenticated yet, reject the connect promise
      if (!this.authenticated && this.connectReject) {
        this.clearConnectTimeout();
        this.connectReject(err);
        this.connectReject = null;
        this.connectResolve = null;
      }
    });
  }

  private handleMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle connect.challenge — sign and respond
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      const payload = msg.payload as { nonce: string; ts: number };
      console.log('[openclaw-ws] Received connect.challenge, signing...');

      const signedAt = Date.now();
      const clientId = 'cli';
      const clientMode = 'cli';
      const platform = process.platform === 'darwin' ? 'macos' : 'linux';
      const deviceFamily = 'cli';
      const role = 'operator';
      const scopes = ['operator.read', 'operator.write'];

      const signature = signConnectPayload(this.device, {
        clientId,
        clientMode,
        platform,
        deviceFamily,
        role,
        scopes,
        signedAt,
        token: this.token,
        nonce: payload.nonce,
      });

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        console.warn('[openclaw-ws] WebSocket not open when trying to send connect');
        return;
      }
      this.ws.send(JSON.stringify({
        type: 'req',
        id: 'connect-1',
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: clientId,
            version: '1.0.0',
            platform,
            mode: clientMode,
            deviceFamily,
          },
          role,
          scopes,
          caps: [],
          commands: [],
          permissions: {},
          auth: { token: this.token },
          locale: 'en-US',
          userAgent: 'relaycast-gateway/1.0.0',
          device: {
            id: this.device.deviceId,
            publicKey: this.device.publicKeyB64,
            signature,
            signedAt,
            nonce: payload.nonce,
          },
        },
      }));
      return;
    }

    // Handle connect response
    if (msg.type === 'res' && msg.id === 'connect-1') {
      this.clearConnectTimeout();
      if (msg.ok) {
        console.log('[openclaw-ws] Authenticated successfully');
        this.authenticated = true;
        this.consecutiveFailures = 0;
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
      } else {
        const errStr = msg.error ? JSON.stringify(msg.error) : 'Authentication rejected';
        const isPairing = /pairing.required|not.paired/i.test(errStr);

        if (isPairing) {
          console.error('[openclaw-ws] Pairing rejected — device is not paired with the OpenClaw gateway.');
          console.error('[openclaw-ws] Ensure OPENCLAW_GATEWAY_TOKEN matches ~/.openclaw/openclaw.json gateway.auth.token');
          this.pairingRejected = true;
        } else {
          console.warn(`[openclaw-ws] Auth rejected: ${errStr}`);
        }

        this.connectReject?.(new Error(`OpenClaw gateway auth failed: ${errStr}`));
        this.connectReject = null;
        this.connectResolve = null;
      }
      return;
    }

    // Handle RPC responses
    const id = msg.id as string | undefined;
    if (id && this.pendingRpcs.has(id)) {
      const pending = this.pendingRpcs.get(id)!;
      clearTimeout(pending.timer);
      this.pendingRpcs.delete(id);

      if (msg.ok === false || msg.error) {
        console.warn(`[openclaw-ws] RPC ${id} error: ${JSON.stringify(msg.error ?? msg)}`);
        pending.resolve(false);
      } else {
        const result = msg.payload as Record<string, unknown> | undefined;
        console.log(`[openclaw-ws] RPC ${id} ok: runId=${result?.runId ?? 'n/a'} status=${result?.status ?? 'n/a'}`);
        pending.resolve(true);
      }
      return;
    }

    // Log other events at debug level
    if (msg.type === 'event') {
      // chat events, tick events, etc. — ignore silently
    }
  }

  /** Send a chat.send RPC. Returns true if accepted. */
  async sendChatMessage(text: string, idempotencyKey?: string): Promise<boolean> {
    if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Try to reconnect
      try {
        await this.connect();
      } catch {
        return false;
      }
      if (!this.authenticated) return false;
    }

    const id = `chat-${++this.rpcIdCounter}-${Date.now()}`;

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[openclaw-ws] chat.send ${id} timed out`);
        this.pendingRpcs.delete(id);
        resolve(false);
      }, 15_000);

      this.pendingRpcs.set(id, { resolve, timer });

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        clearTimeout(timer);
        this.pendingRpcs.delete(id);
        resolve(false);
        return;
      }
      this.ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'chat.send',
        params: {
          sessionKey: 'agent:main:main',
          message: text,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      }));
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.pairingRejected || this.reconnectTimer) return;

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= OpenClawGatewayClient.MAX_CONSECUTIVE_FAILURES) {
      console.warn(`[openclaw-ws] ${this.consecutiveFailures} consecutive connection failures — stopping reconnect.`);
      console.warn('[openclaw-ws] Check that the OpenClaw gateway is running and OPENCLAW_GATEWAY_TOKEN is correct.');
      return;
    }

    const delay = Math.min(
      OpenClawGatewayClient.BASE_RECONNECT_MS * Math.pow(2, this.consecutiveFailures - 1),
      OpenClawGatewayClient.MAX_RECONNECT_MS,
    );
    console.log(`[openclaw-ws] Reconnecting in ${delay / 1000}s (attempt ${this.consecutiveFailures})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearConnectTimeout();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [id, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.pendingRpcs.delete(id);
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.authenticated = false;
    // Clear any pending connect promise
    this.connectReject = null;
    this.connectResolve = null;
  }
}

// ---------------------------------------------------------------------------
// InboundGateway
// ---------------------------------------------------------------------------

export class InboundGateway {
  private readonly relaySender: RelaySender | null;
  private relayAgentClient: AgentClient | null = null;
  private readonly relaycast: RelayCast;
  private readonly config: GatewayConfig;
  private readonly dedupeTtlMs: number;

  private running = false;
  private unsubscribeHandlers: Array<() => void> = [];
  private seenMessageIds = new Map<string, number>();
  private processingMessageIds = new Set<string>();

  /** Persistent WebSocket client for the local OpenClaw gateway. */
  private openclawClient: OpenClawGatewayClient | null = null;

  /** Spawn manager — lives in the gateway so spawned processes survive MCP server restarts. */
  private spawnManager: SpawnManager;
  /** HTTP control server for spawn/list/release commands. */
  private controlServer: HttpServer | null = null;
  /** Port the control server listens on. */
  controlPort = 0;

  /** Default control port for the gateway's spawn API. */
  static readonly DEFAULT_CONTROL_PORT = 18790;

  constructor(options: GatewayOptions) {
    this.config = {
      ...options.config,
      channels: options.config.channels.map(normalizeChannelName),
    };
    this.relaySender = options.relaySender ?? null;
    this.relaycast = new RelayCast({
      apiKey: this.config.apiKey,
      baseUrl: this.config.baseUrl,
    });

    const dedupeTtlMs = Number(process.env.RELAYCAST_DEDUPE_TTL_MS ?? 15 * 60 * 1000);
    this.dedupeTtlMs = Number.isFinite(dedupeTtlMs) && dedupeTtlMs >= 1000
      ? Math.floor(dedupeTtlMs)
      : 15 * 60 * 1000;

    const parentDepth = Number(process.env.OPENCLAW_SPAWN_DEPTH || 0);
    this.spawnManager = new SpawnManager({ spawnDepth: parentDepth + 1 });
  }

  /** Start the gateway — register agent and subscribe for realtime events. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Connect to the local OpenClaw gateway WebSocket (persistent connection)
    const token = this.config.openclawGatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN;
    const port = this.config.openclawGatewayPort ?? DEFAULT_OPENCLAW_GATEWAY_PORT;

    if (token) {
      this.openclawClient = new OpenClawGatewayClient(token, port);
      try {
        await this.openclawClient.connect();
        console.log('[gateway] OpenClaw gateway WebSocket client ready');
      } catch (err) {
        console.warn(`[gateway] OpenClaw gateway WS failed (will retry per message): ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.warn('[gateway] No OPENCLAW_GATEWAY_TOKEN — local delivery disabled');
    }

    const registered = await this.relaycast.agents.registerOrGet({
      name: this.config.clawName,
      type: 'agent',
      persona: 'Relaycast inbound gateway for OpenClaw',
    });

    this.relayAgentClient = this.relaycast.as(registered.token);

    // Connect first, then register handlers. The SDK requires connect()
    // before subscribe() can be called.
    this.relayAgentClient.connect();

    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.connected(() => {
        console.log(`[gateway] Relaycast WebSocket connected, subscribing to channels: ${this.config.channels.join(', ')}`);
        this.relayAgentClient?.subscribe(this.config.channels);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.messageCreated((event: MessageCreatedEvent) => {
        console.log(`[gateway] Realtime message from @${event.message?.agentName} in #${event.channel}`);
        void this.handleRealtimeMessage(event);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.threadReply((event: ThreadReplyEvent) => {
        console.log(`[gateway] Thread reply from @${event.message?.agentName} in #${event.channel} (parent: ${event.parentId})`);
        void this.handleRealtimeThreadReply(event);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.dmReceived((event: DmReceivedEvent) => {
        console.log(`[gateway] DM from @${event.message?.agentName} (conv: ${event.conversationId})`);
        void this.handleRealtimeDm(event);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.groupDmReceived((event: GroupDmReceivedEvent) => {
        console.log(`[gateway] Group DM from @${event.message?.agentName} (conv: ${event.conversationId})`);
        void this.handleRealtimeGroupDm(event);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.commandInvoked((event: CommandInvokedEvent) => {
        console.log(`[gateway] Command /${event.command} invoked by @${event.invokedBy} in #${event.channel}`);
        void this.handleRealtimeCommand(event);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reactionAdded((event: ReactionAddedEvent) => {
        console.log(`[gateway] Reaction :${event.emoji}: added by @${event.agentName} on ${event.messageId}`);
        void this.handleRealtimeReaction(event, 'added');
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reactionRemoved((event: ReactionRemovedEvent) => {
        console.log(`[gateway] Reaction :${event.emoji}: removed by @${event.agentName} from ${event.messageId}`);
        void this.handleRealtimeReaction(event, 'removed');
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reconnecting((attempt: number) => {
        console.warn(`[gateway] Relaycast reconnecting (attempt ${attempt})`);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.disconnected(() => {
        console.warn(`[gateway] Relaycast disconnected`);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.error(() => {
        console.warn(`[gateway] Relaycast socket error`);
      }),
    );

    await this.ensureChannelMembership();

    // Also subscribe explicitly in case the `connected` event already fired
    // before we registered the handler above.
    try {
      this.relayAgentClient.subscribe(this.config.channels);
    } catch {
      // Will subscribe on next connected event
    }

    console.log(
      `[gateway] Realtime listening on channels: ${this.config.channels.join(', ')}`,
    );

    // Start spawn control HTTP server
    await this.startControlServer();
  }

  /** Stop the gateway — clean up websocket and relay clients. */
  async stop(): Promise<void> {
    this.running = false;

    for (const unsubscribe of this.unsubscribeHandlers) {
      try {
        unsubscribe();
      } catch {
        // Best effort
      }
    }
    this.unsubscribeHandlers = [];

    if (this.relayAgentClient) {
      try {
        await this.relayAgentClient.disconnect();
      } catch {
        // Best effort
      }
      this.relayAgentClient = null;
    }

    if (this.openclawClient) {
      await this.openclawClient.disconnect();
      this.openclawClient = null;
    }

    // Stop control server and release all spawns
    if (this.controlServer) {
      this.controlServer.close();
      this.controlServer = null;
    }
    await this.spawnManager.releaseAll();

    this.processingMessageIds.clear();
    this.seenMessageIds.clear();
  }

  private cleanupSeenMap(nowMs: number): void {
    for (const [id, seenAt] of this.seenMessageIds.entries()) {
      if (nowMs - seenAt > this.dedupeTtlMs) {
        this.seenMessageIds.delete(id);
      }
    }
  }

  private isSeen(messageId: string): boolean {
    const nowMs = Date.now();
    this.cleanupSeenMap(nowMs);
    return this.seenMessageIds.has(messageId);
  }

  private markSeen(messageId: string): void {
    const nowMs = Date.now();
    this.cleanupSeenMap(nowMs);
    this.seenMessageIds.set(messageId, nowMs);
  }

  private async ensureChannelMembership(): Promise<void> {
    if (!this.relayAgentClient) return;

    for (const channel of this.config.channels) {
      try {
        await this.relayAgentClient.channels.join(channel);
      } catch {
        try {
          await this.relayAgentClient.channels.create({ name: channel });
          await this.relayAgentClient.channels.join(channel);
        } catch {
          // Non-fatal
        }
      }
    }
  }

  private async handleRealtimeMessage(event: MessageCreatedEvent): Promise<void> {
    const channel = normalizeChannelName(event.channel);
    if (!this.config.channels.includes(channel)) return;

    const messageId = event.message?.id;
    if (!messageId) return;

    const inbound: InboundMessage = {
      id: messageId,
      channel,
      from: event.message.agentName,
      text: event.message.text,
      timestamp: new Date().toISOString(),
    };

    await this.handleInbound(inbound);
  }

  private async handleRealtimeThreadReply(event: ThreadReplyEvent): Promise<void> {
    const channel = normalizeChannelName(event.channel);
    if (!this.config.channels.includes(channel)) return;

    const messageId = event.message?.id;
    if (!messageId) return;

    const inbound: InboundMessage = {
      id: messageId,
      channel,
      from: event.message.agentName,
      text: event.message.text,
      timestamp: new Date().toISOString(),
      threadParentId: event.parentId,
    };

    await this.handleInbound(inbound);
  }

  private async handleRealtimeDm(event: DmReceivedEvent): Promise<void> {
    const messageId = event.message?.id;
    if (!messageId) return;

    const inbound: InboundMessage = {
      id: messageId,
      channel: 'dm',
      from: event.message.agentName,
      text: event.message.text,
      timestamp: new Date().toISOString(),
      conversationId: event.conversationId,
      kind: 'dm',
    };

    await this.handleInbound(inbound);
  }

  private async handleRealtimeGroupDm(event: GroupDmReceivedEvent): Promise<void> {
    const messageId = event.message?.id;
    if (!messageId) return;

    const inbound: InboundMessage = {
      id: messageId,
      channel: `groupdm:${event.conversationId}`,
      from: event.message.agentName,
      text: event.message.text,
      timestamp: new Date().toISOString(),
      conversationId: event.conversationId,
      kind: 'groupdm',
    };

    await this.handleInbound(inbound);
  }

  private async handleRealtimeCommand(event: CommandInvokedEvent): Promise<void> {
    const channel = normalizeChannelName(event.channel);
    if (!this.config.channels.includes(channel)) return;

    // Commands lack a server-assigned event ID, so we synthesize one.
    // We include args + timestamp to avoid silently dropping legitimate
    // repeat invocations (e.g. /deploy twice in 15 min). This means SDK
    // reconnection replays may deliver a duplicate, but that's less
    // harmful than silently swallowing a real command.
    const argsSlug = event.args ? `_${event.args}` : '';
    const syntheticId = `cmd_${event.command}_${channel}_${event.invokedBy}${argsSlug}_${Date.now()}`;
    const argsText = event.args ? ` ${event.args}` : '';

    const inbound: InboundMessage = {
      id: syntheticId,
      channel,
      from: event.invokedBy,
      text: `[relaycast:command:${channel}] @${event.invokedBy} /${event.command}${argsText}`,
      timestamp: new Date().toISOString(),
      kind: 'command',
    };

    await this.handleInbound(inbound);
  }

  private async handleRealtimeReaction(
    event: ReactionAddedEvent | ReactionRemovedEvent,
    action: 'added' | 'removed',
  ): Promise<void> {
    // Include timestamp so add→remove→re-add of the same emoji isn't
    // silently dropped within the 15-min dedup window. Reactions are soft
    // notifications, so a rare duplicate on SDK reconnect is acceptable.
    const syntheticId = `reaction_${event.messageId}_${event.emoji}_${event.agentName}_${action}_${Date.now()}`;
    const text = action === 'added'
      ? `[relaycast:reaction] @${event.agentName} reacted ${event.emoji} to message ${event.messageId} (soft notification, no action required)`
      : `[relaycast:reaction] @${event.agentName} removed ${event.emoji} from message ${event.messageId} (soft notification, no action required)`;

    const inbound: InboundMessage = {
      id: syntheticId,
      channel: 'reaction',
      from: event.agentName,
      text,
      timestamp: new Date().toISOString(),
      kind: 'reaction',
    };

    await this.handleInbound(inbound);
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    if (!this.running) return;
    if (this.processingMessageIds.has(message.id) || this.isSeen(message.id)) return;

    // Avoid echo loops — skip messages from this claw.
    if (message.from === this.config.clawName) {
      // Only update cursor for real channels with real (non-synthetic) message IDs.
      this.markSeen(message.id);
      return;
    }

    // Mark as seen immediately to prevent duplicate delivery from concurrent
    // realtime events processing the same message.
    this.markSeen(message.id);
    this.processingMessageIds.add(message.id);

    console.log(`[gateway] Delivering message ${message.id} from @${message.from}: "${message.text}"`);
    try {
      const result = await this.onMessage(message);
      console.log(`[gateway] Delivery result: ${result.method} ok=${result.ok}${result.error ? ' error=' + result.error : ''}`);
    } finally {
      this.processingMessageIds.delete(message.id);
    }
  }

  /** Format delivery text with channel, sender, and optional thread prefix. */
  private formatDeliveryText(message: InboundMessage): string {
    // Pre-formatted kinds (command, reaction) already have the full text.
    if (message.kind === 'command' || message.kind === 'reaction') {
      return message.text;
    }
    if (message.kind === 'dm') {
      return `[relaycast:dm] @${message.from}: ${message.text}`;
    }
    if (message.kind === 'groupdm') {
      return `[relaycast:groupdm] @${message.from}: ${message.text}`;
    }
    const threadPrefix = message.threadParentId ? '[thread] ' : '';
    return `${threadPrefix}[relaycast:${message.channel}] @${message.from}: ${message.text}`;
  }

  /** Handle an inbound Relaycast message. */
  private async onMessage(message: InboundMessage): Promise<DeliveryResult> {
    // Try primary delivery via the shared relay sender (no extra broker spawned).
    if (this.relaySender) {
      const ok = await this.deliverViaRelaySender(message);
      if (ok) {
        return { ok: true, method: 'relay_sdk' };
      }
    }

    // Deliver via persistent OpenClaw gateway WebSocket connection
    if (this.openclawClient) {
      const text = this.formatDeliveryText(message);
      const ok = await this.openclawClient.sendChatMessage(text, message.id);
      if (ok) {
        return { ok: true, method: 'gateway_ws' };
      }
    }

    console.warn(
      `[gateway] Failed to deliver message ${message.id} from @${message.from}`,
    );
    return { ok: false, method: 'failed', error: 'All delivery methods failed' };
  }

  /** Deliver via the caller-provided relay sender (shared broker). */
  private async deliverViaRelaySender(message: InboundMessage): Promise<boolean> {
    if (!this.relaySender) return false;

    const input: SendMessageInput = {
      to: this.config.clawName,
      text: this.formatDeliveryText(message),
      from: message.from,
      data: {
        source: 'relaycast',
        channel: message.channel,
        messageId: message.id,
      },
    };

    try {
      const result = await this.relaySender.sendMessage(input);
      return Boolean(result.event_id) && result.event_id !== 'unsupported_operation';
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Spawn control HTTP server
  // -------------------------------------------------------------------------

  private async startControlServer(): Promise<void> {
    const port = Number(process.env.RELAYCAST_CONTROL_PORT) || InboundGateway.DEFAULT_CONTROL_PORT;

    this.controlServer = createServer((req, res) => {
      void this.handleControlRequest(req, res);
    });

    return new Promise((resolve) => {
      this.controlServer!.listen(port, '127.0.0.1', () => {
        this.controlPort = port;
        console.log(`[gateway] Spawn control API listening on http://127.0.0.1:${port}`);
        resolve();
      });
      this.controlServer!.on('error', (err) => {
        console.warn(`[gateway] Control server failed to start on port ${port}: ${err.message}`);
        this.controlServer = null;
        resolve(); // Non-fatal
      });
    });
  }

  private async handleControlRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // CORS for local callers
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        status: 'running',
        active: this.spawnManager.size,
        uptime: process.uptime(),
      }));
      return;
    }

    if (req.method === 'POST' && path === '/spawn') {
      const body = await readBody(req);
      try {
        const args = JSON.parse(body) as Record<string, unknown>;
        const name = args.name as string;
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: '"name" is required' }));
          return;
        }

        const relayApiKey = this.config.apiKey;
        const spawnOpts: SpawnOptions = {
          name,
          relayApiKey,
          role: (args.role as string) || undefined,
          model: (args.model as string) || undefined,
          channels: (args.channels as string[]) || undefined,
          systemPrompt: (args.system_prompt as string) || undefined,
          relayBaseUrl: this.config.baseUrl,
          workspaceId: (args.workspace_id as string) || process.env.OPENCLAW_WORKSPACE_ID,
        };

        const handle = await this.spawnManager.spawn(spawnOpts);
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          name: handle.displayName,
          agentName: handle.agentName,
          id: handle.id,
          gatewayPort: handle.gatewayPort,
          active: this.spawnManager.size,
        }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/list') {
      const handles = this.spawnManager.list();
      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        active: handles.length,
        claws: handles.map(h => ({
          name: h.displayName,
          agentName: h.agentName,
          id: h.id,
          gatewayPort: h.gatewayPort,
        })),
      }));
      return;
    }

    if (req.method === 'POST' && path === '/release') {
      const body = await readBody(req);
      try {
        const args = JSON.parse(body) as Record<string, unknown>;
        const name = args.name as string | undefined;
        const id = args.id as string | undefined;

        if (!name && !id) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'Provide "name" or "id"' }));
          return;
        }

        let released = false;
        if (id) {
          released = await this.spawnManager.release(id);
        } else if (name) {
          released = await this.spawnManager.releaseByName(name);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ ok: released, active: this.spawnManager.size }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', (err) => reject(err));
  });
}
