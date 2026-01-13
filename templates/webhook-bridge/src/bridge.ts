/**
 * WebhookBridge - HTTP ↔ Agent Relay bridge
 */

import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { RelayClient, getProjectPaths } from 'agent-relay';

interface BridgeConfig {
  name: string;
  secret?: string;
  socketPath?: string;
}

export class WebhookBridge {
  private relay: RelayClient;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;

    const paths = getProjectPaths();
    this.relay = new RelayClient({
      name: config.name,
      socketPath: config.socketPath || paths.socketPath,
    });

    this.setupRelayHandlers();
  }

  private setupRelayHandlers(): void {
    // Handle outgoing webhooks
    this.relay.on('message', async (msg) => {
      if (msg.from === this.config.name) return;

      const webhookUrl = msg.data?.webhookUrl?.toString();
      if (!webhookUrl) return;

      console.log(`[Relay → Webhook] ${msg.from} → ${webhookUrl}`);

      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: msg.from,
            body: msg.body,
            data: msg.data,
            timestamp: Date.now(),
          }),
        });

        if (!response.ok) {
          console.error(`[Webhook] Failed: ${response.status} ${response.statusText}`);
        }
      } catch (err) {
        console.error('[Webhook] Error:', err);
      }
    });

    this.relay.on('connected', () => {
      console.log(`[Relay] Connected as ${this.config.name}`);
    });

    this.relay.on('error', (err) => {
      console.error('[Relay] Error:', err);
    });
  }

  async connect(): Promise<void> {
    await this.relay.connect();
    await this.relay.broadcast(`${this.config.name} online`);
  }

  async disconnect(): Promise<void> {
    await this.relay.broadcast(`${this.config.name} offline`);
    await this.relay.disconnect();
  }

  isConnected(): boolean {
    return this.relay.state === 'READY';
  }

  async handleWebhook(req: Request, res: Response): Promise<void> {
    // Verify signature if secret is configured
    if (this.config.secret) {
      const signature = req.headers['x-webhook-signature']?.toString();
      if (!this.verifySignature(req.body, signature)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const topic = req.params.topic;
    const to = req.query.to?.toString();
    const thread = req.query.thread?.toString();

    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    console.log(`[Webhook → Relay] ${topic || 'default'}: ${body.substring(0, 100)}...`);

    try {
      if (to) {
        // Send to specific agent
        await this.relay.send({
          to,
          body,
          thread,
          data: {
            source: 'webhook',
            topic,
            headers: this.sanitizeHeaders(req.headers),
          },
        });
      } else {
        // Broadcast to all
        await this.relay.broadcast(body, {
          source: 'webhook',
          topic,
          headers: this.sanitizeHeaders(req.headers),
        });
      }

      res.json({ ok: true, delivered: true });
    } catch (err) {
      console.error('[Webhook] Relay error:', err);
      res.status(500).json({ error: 'Failed to relay message' });
    }
  }

  private verifySignature(body: unknown, signature?: string): boolean {
    if (!signature || !this.config.secret) return false;

    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const expected = `sha256=${crypto
      .createHmac('sha256', this.config.secret)
      .update(payload)
      .digest('hex')}`;

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  }

  private sanitizeHeaders(headers: Request['headers']): Record<string, string> {
    // Only include safe headers
    const safe = ['content-type', 'user-agent', 'x-request-id', 'x-correlation-id'];
    const result: Record<string, string> = {};

    for (const key of safe) {
      if (headers[key]) {
        result[key] = headers[key]!.toString();
      }
    }

    return result;
  }
}
