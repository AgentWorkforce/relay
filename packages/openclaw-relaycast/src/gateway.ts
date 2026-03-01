import type { SendMessageInput } from '@agent-relay/sdk';
import { RelayCast, type AgentClient, type MessageCreatedEvent, type MessageWithMeta } from '@relaycast/sdk';

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

    // Register with a viewer- prefixed name so we don't collide with the
    // container broker's agent registration (which uses the bare clawName).
    // Using the same name would cause registerOrRotate to steal the name
    // and release the container's agent.
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

    this.relayAgentClient.connect();

    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.connected(() => {
        this.relayAgentClient?.subscribe(this.config.channels);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.messageCreated((event) => {
        void this.handleRealtimeMessage(event);
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.reconnecting((attempt) => {
        console.warn(
          `[gateway] ${this.config.clawName} realtime reconnecting (attempt ${attempt})`,
        );
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.permanentlyDisconnected((attempt) => {
        console.warn(
          `[gateway] ${this.config.clawName} realtime permanently disconnected at attempt ${attempt}`,
        );
      }),
    );
    this.unsubscribeHandlers.push(
      this.relayAgentClient.on.error(() => {
        console.warn(`[gateway] ${this.config.clawName} realtime socket error`);
      }),
    );

    await this.ensureChannelMembership();

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

    // Note: we do NOT shut down the relaySender — it's owned by the caller
    // (the API server's shared relay instance).

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
      } catch {
        // Non-fatal — realtime path remains active.
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

    this.processingMessageIds.add(message.id);
    try {
      const result = await this.onMessage(message);
      if (result.ok) {
        this.channelCursor.set(normalizeChannelName(message.channel), message.id);
        this.markSeen(message.id);
      }
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

    // Fallback to OpenClaw sessions_send RPC (only works when the gateway
    // runs in the same container as the OpenClaw gateway — primarily for
    // future in-container use).
    const fallbackOk = await this.deliverViaSessionsRpc(message);
    if (fallbackOk) {
      return { ok: true, method: 'sessions_rpc' };
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

  /** FALLBACK: Deliver via OpenClaw sessions_send RPC. */
  private async deliverViaSessionsRpc(message: InboundMessage): Promise<boolean> {
    try {
      const response = await fetch('http://127.0.0.1:18789', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'sessions_send',
          params: {
            text: `[relaycast:${message.channel}] @${message.from}: ${message.text}`,
          },
          id: message.id,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
