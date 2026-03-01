import { AgentRelayClient, type SendMessageInput } from '@agent-relay/sdk';

import type { GatewayConfig, InboundMessage, DeliveryResult } from './types.js';

export interface GatewayOptions {
  /** Gateway configuration. */
  config: GatewayConfig;
  /** Optional pre-existing AgentRelayClient instance. */
  relayClient?: AgentRelayClient;
}

export class InboundGateway {
  private relayClient: AgentRelayClient | null = null;
  private config: GatewayConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSeenMessageId: string | null = null;
  private agentToken: string | null = null;

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.relayClient = options.relayClient ?? null;
  }

  /** Start the gateway — register agent, join channels, start polling. */
  async start(): Promise<void> {
    this.running = true;

    // Register as agent in Relaycast
    const regRes = await fetch(`${this.config.baseUrl}/v1/agents/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        name: this.config.clawName,
        type: 'agent',
        persona: 'OpenClaw instance with Relaycast bridge',
      }),
    });

    if (regRes.ok) {
      const data = (await regRes.json()) as { token?: string };
      this.agentToken = data.token ?? null;
    }

    // Join configured channels
    for (const ch of this.config.channels) {
      try {
        await fetch(`${this.config.baseUrl}/v1/channels/${encodeURIComponent(ch)}/join`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.agentToken ?? this.config.apiKey}`,
          },
        });
      } catch {
        // Try to create the channel first, then join
        try {
          await fetch(`${this.config.baseUrl}/v1/channels`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.agentToken ?? this.config.apiKey}`,
            },
            body: JSON.stringify({ name: ch }),
          });
        } catch {
          // Non-fatal
        }
      }
    }

    // Poll channels for new messages
    this.pollTimer = setInterval(() => {
      void this.pollMessages();
    }, 3000);

    // Do an initial poll immediately
    await this.pollMessages();

    console.log(
      `[gateway] Listening for messages on channels: ${this.config.channels.join(', ')}`,
    );
  }

  /** Stop the gateway — clean up. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.relayClient) {
      try {
        await this.relayClient.shutdown();
      } catch {
        // Best effort
      }
      this.relayClient = null;
    }
  }

  /** Poll channels for new messages and deliver them. */
  private async pollMessages(): Promise<void> {
    if (!this.running) return;

    for (const channel of this.config.channels) {
      try {
        const url = new URL(`${this.config.baseUrl}/v1/channels/${encodeURIComponent(channel)}/messages`);
        if (this.lastSeenMessageId) {
          url.searchParams.set('after', this.lastSeenMessageId);
        }
        url.searchParams.set('limit', '20');

        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${this.agentToken ?? this.config.apiKey}`,
          },
        });

        if (!res.ok) continue;

        const data = (await res.json()) as {
          messages?: Array<{
            id: string;
            channel?: string;
            agentName?: string;
            agent_name?: string;
            text: string;
            createdAt?: string;
            created_at?: string;
          }>;
        };

        const messages = data.messages ?? [];

        for (const msg of messages) {
          const from = msg.agentName ?? msg.agent_name ?? 'unknown';

          // Skip own messages to avoid echo loops
          if (from === this.config.clawName) continue;

          const inbound: InboundMessage = {
            id: msg.id,
            channel,
            from,
            text: msg.text,
            timestamp: msg.createdAt ?? msg.created_at ?? new Date().toISOString(),
          };

          const result = await this.onMessage(inbound);
          if (result.ok) {
            this.lastSeenMessageId = msg.id;
          }
        }
      } catch {
        // Non-fatal — will retry on next poll
      }
    }
  }

  /** Handle an inbound Relaycast message. */
  private async onMessage(message: InboundMessage): Promise<DeliveryResult> {
    // Try primary delivery via Agent Relay SDK
    const primaryOk = await this.deliverViaRelaySdk(message);
    if (primaryOk) {
      return { ok: true, method: 'relay_sdk' };
    }

    // Fallback to OpenClaw sessions_send RPC
    const fallbackOk = await this.deliverViaSessionsRpc(message);
    if (fallbackOk) {
      return { ok: true, method: 'sessions_rpc' };
    }

    console.warn(
      `[gateway] Failed to deliver message ${message.id} from @${message.from}`,
    );
    return { ok: false, method: 'failed', error: 'All delivery methods failed' };
  }

  /** PRIMARY: Deliver via Agent Relay SDK sendMessage(). */
  private async deliverViaRelaySdk(
    message: InboundMessage,
  ): Promise<boolean> {
    if (!this.relayClient) {
      try {
        this.relayClient = await AgentRelayClient.start({
          clientName: 'openclaw-relaycast',
          clientVersion: '1.0.0',
        });
      } catch {
        return false; // Broker not available
      }
    }

    try {
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

      const result = await this.relayClient.sendMessage(input);
      return Boolean(result.event_id) && result.event_id !== 'unsupported_operation';
    } catch {
      return false;
    }
  }

  /** FALLBACK: Deliver via OpenClaw sessions_send RPC. */
  private async deliverViaSessionsRpc(
    message: InboundMessage,
  ): Promise<boolean> {
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
