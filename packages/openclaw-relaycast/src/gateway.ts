import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import type { SendMessageInput } from '@agent-relay/sdk';
import { RelayCast, type AgentClient, type MessageCreatedEvent, type MessageWithMeta } from '@relaycast/sdk';
import WebSocket from 'ws';

import type { GatewayConfig, InboundMessage, DeliveryResult } from './types.js';

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

class OpenClawGatewayClient {
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

  constructor(token: string, port: number) {
    this.token = token;
    this.port = port;
    this.device = generateDeviceIdentity();
  }

  /** Connect and authenticate. Resolves when chat.send is ready. */
  async connect(): Promise<void> {
    if (this.authenticated && this.ws?.readyState === WebSocket.OPEN) return;

    this.connectPromise = new Promise<void>((resolve) => {
      this.connectResolve = resolve;
    });

    this.doConnect();
    return this.connectPromise;
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
      console.warn(`[openclaw-ws] Disconnected: ${code} ${reason.toString()}`);
      this.authenticated = false;
      // Reject all pending RPCs
      for (const [id, pending] of this.pendingRpcs) {
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pendingRpcs.delete(id);
      }
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.warn(`[openclaw-ws] Error: ${err.message}`);
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
      if (msg.ok) {
        console.log('[openclaw-ws] Authenticated successfully');
        this.authenticated = true;
        this.connectResolve?.();
        this.connectResolve = null;
      } else {
        console.warn(`[openclaw-ws] Auth rejected: ${JSON.stringify(msg.error ?? msg)}`);
        this.connectResolve?.();
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
    if (this.stopped || this.reconnectTimer) return;
    console.log('[openclaw-ws] Reconnecting in 3s...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, 3_000);
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
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
  private readonly fallbackPollMs: number;
  private readonly dedupeTtlMs: number;

  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeHandlers: Array<() => void> = [];
  private seenMessageIds = new Map<string, number>();
  private processingMessageIds = new Set<string>();
  private channelCursor = new Map<string, string>();

  /** Persistent WebSocket client for the local OpenClaw gateway. */
  private openclawClient: OpenClawGatewayClient | null = null;

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

    const fallbackPollMs = Number(process.env.RELAYCAST_FALLBACK_POLL_MS ?? 15000);
    this.fallbackPollMs = Number.isFinite(fallbackPollMs) && fallbackPollMs >= 1000
      ? Math.floor(fallbackPollMs)
      : 15000;

    const dedupeTtlMs = Number(process.env.RELAYCAST_DEDUPE_TTL_MS ?? 15 * 60 * 1000);
    this.dedupeTtlMs = Number.isFinite(dedupeTtlMs) && dedupeTtlMs >= 1000
      ? Math.floor(dedupeTtlMs)
      : 15 * 60 * 1000;
  }

  /** Start the gateway — register agent, subscribe for realtime events, and run fallback polling. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Connect to the local OpenClaw gateway WebSocket (persistent connection)
    const token = this.config.openclawGatewayToken ?? process.env.OPENCLAW_GATEWAY_TOKEN;
    const port = this.config.openclawGatewayPort ?? 18789;

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

    // Register with a viewer- prefixed name so we don't collide with the
    // container broker's agent registration (which uses the bare clawName).
    const viewerName = `viewer-${this.config.clawName}`;
    const registered = await this.relaycast.registerOrRotate({
      name: viewerName,
      type: 'system',
      persona: 'Relaycast inbound gateway for OpenClaw',
    });

    this.relayAgentClient = this.relaycast.as(registered.token, {
      autoHeartbeatMs: 30_000,
      ws: {
        maxReconnectAttempts: Number.POSITIVE_INFINITY,
        reconnectJitter: true,
        reconnectBaseDelayMs: 1_000,
        reconnectMaxDelayMs: 30_000,
      },
    });

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
      this.relayAgentClient.on.messageCreated((event) => {
        console.log(`[gateway] Realtime message from @${event.message?.agentName} in #${event.channel}`);
        void this.handleRealtimeMessage(event);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reconnecting((attempt) => {
        console.warn(`[gateway] Relaycast reconnecting (attempt ${attempt})`);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.permanentlyDisconnected((attempt) => {
        console.warn(`[gateway] Relaycast permanently disconnected at attempt ${attempt}`);
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

    // Initial catch-up in case messages arrived before realtime subscription was active.
    await this.pollMessages();

    // Keep a low-frequency poll as recovery/backfill only.
    this.pollTimer = setInterval(() => {
      void this.pollMessages();
    }, this.fallbackPollMs);

    console.log(
      `[gateway] Realtime listening on channels: ${this.config.channels.join(', ')}`,
    );
  }

  /** Stop the gateway — clean up websocket and relay clients. */
  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

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

    this.processingMessageIds.clear();
    this.channelCursor.clear();
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

  private normalizePolledMessage(channel: string, message: MessageWithMeta): InboundMessage {
    return {
      id: message.id,
      channel,
      from: message.agentName,
      text: message.text,
      timestamp: message.createdAt,
    };
  }

  /** Poll channels for catch-up/recovery only. */
  private async pollMessages(): Promise<void> {
    if (!this.running) return;

    for (const channel of this.config.channels) {
      try {
        const after = this.channelCursor.get(channel);
        const query: { limit: number; after?: string } = { limit: 50 };
        if (after) {
          query.after = after;
        }

        const messages = await this.relaycast.messages.list(channel, query);
        const ordered = [...messages].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );

        for (const message of ordered) {
          await this.handleInbound(this.normalizePolledMessage(channel, message));
        }
      } catch (err) {
        console.warn(`[gateway] Poll error for #${channel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    if (!this.running) return;
    if (this.processingMessageIds.has(message.id) || this.isSeen(message.id)) return;

    // Avoid echo loops — skip messages from this claw or its viewer identity.
    const viewerName = `viewer-${this.config.clawName}`;
    if (message.from === this.config.clawName || message.from === viewerName) {
      this.channelCursor.set(normalizeChannelName(message.channel), message.id);
      this.markSeen(message.id);
      return;
    }

    // Mark as seen immediately to prevent duplicate delivery from concurrent
    // realtime + poll paths processing the same message.
    this.markSeen(message.id);
    this.processingMessageIds.add(message.id);

    console.log(`[gateway] Delivering message ${message.id} from @${message.from}: "${message.text}"`);
    try {
      const result = await this.onMessage(message);
      console.log(`[gateway] Delivery result: ${result.method} ok=${result.ok}${result.error ? ' error=' + result.error : ''}`);
      this.channelCursor.set(normalizeChannelName(message.channel), message.id);
    } finally {
      this.processingMessageIds.delete(message.id);
    }
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
      const text = `[relaycast:${message.channel}] @${message.from}: ${message.text}`;
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
      text: `[relaycast:${message.channel}] @${message.from}: ${message.text}`,
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
}
