/**
 * WhatsApp Surface Adapter
 *
 * Implements SurfaceAdapter for WhatsApp Cloud API.
 * - verify(): X-Hub-Signature-256 HMAC verification (Meta webhook standard)
 * - receive(): Parses WhatsApp Cloud API webhook notifications
 * - deliver(): Sends messages via Meta Cloud API /messages endpoint
 */

import crypto from 'crypto';
import type {
  SurfaceAdapter,
  SignatureConfig,
  HeaderMap,
  NormalizedMessage,
  OutboundMessage,
  DeliveryResult,
  GatewayMetadata,
} from '../types.js';

export interface WhatsAppAdapterOptions {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  apiVersion?: string;
}

export class WhatsAppAdapter implements SurfaceAdapter {
  readonly type = 'whatsapp' as const;
  readonly signature: SignatureConfig = {
    header: 'x-hub-signature-256',
    algorithm: 'sha256',
    secretEnvVar: 'WHATSAPP_APP_SECRET',
    signaturePrefix: 'sha256=',
  };

  private phoneNumberId: string;
  private accessToken: string;
  private appSecret: string;
  private apiVersion: string;

  constructor(options: WhatsAppAdapterOptions) {
    this.phoneNumberId = options.phoneNumberId;
    this.accessToken = options.accessToken;
    this.appSecret = options.appSecret;
    this.apiVersion = options.apiVersion ?? 'v21.0';
  }

  verify(payload: string, headers: HeaderMap): boolean {
    const signature = headers['x-hub-signature-256'] as string | undefined;
    if (!signature) return false;

    const sig = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    const expected = crypto.createHmac('sha256', this.appSecret).update(payload).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  receive(payload: unknown, _headers: HeaderMap): NormalizedMessage[] {
    const data = payload as Record<string, unknown>;
    const messages: NormalizedMessage[] = [];

    // WhatsApp Cloud API uses "entry" array
    const entries = data.entry as Array<Record<string, unknown>> | undefined;
    if (!entries) return [];

    for (const entry of entries) {
      const changes = entry.changes as Array<Record<string, unknown>> | undefined;
      if (!changes) continue;

      for (const change of changes) {
        const value = change.value as Record<string, unknown> | undefined;
        if (!value) continue;

        const metadata = value.metadata as Record<string, unknown> | undefined;
        const phoneNumberId = (metadata?.phone_number_id as string) || 'unknown';

        // Handle incoming messages
        const incomingMessages = value.messages as Array<Record<string, unknown>> | undefined;
        if (incomingMessages) {
          for (const msg of incomingMessages) {
            const contact = (value.contacts as Array<Record<string, unknown>>)?.find(
              (c: Record<string, unknown>) => c.wa_id === msg.from
            );
            const profile = contact?.profile as Record<string, unknown> | undefined;

            const text =
              msg.type === 'text' ? ((msg.text as Record<string, unknown>)?.body as string) : undefined;

            messages.push({
              id: (msg.id as string) || `wa-${Date.now()}`,
              source: 'whatsapp',
              type: 'message',
              timestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
              actor: {
                id: (msg.from as string) || 'unknown',
                name: (profile?.name as string) || (msg.from as string) || 'unknown',
              },
              context: {
                name: phoneNumberId,
                conversationId: (msg.context as Record<string, unknown>)?.id as string | undefined,
              },
              item: {
                type: 'message',
                id: (msg.id as string) || 'unknown',
                body: text || `[${msg.type as string}]`,
              },
              mentions: this.extractMentions(text),
              labels: [],
              metadata: {
                phoneNumberId,
                messageType: msg.type,
                context: msg.context,
              },
              rawPayload: payload,
            });
          }
        }

        // Handle status updates
        const statuses = value.statuses as Array<Record<string, unknown>> | undefined;
        if (statuses) {
          for (const status of statuses) {
            messages.push({
              id: (status.id as string) || `wa-status-${Date.now()}`,
              source: 'whatsapp',
              type: `status_${status.status as string}`,
              timestamp: status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date(),
              actor: {
                id: (status.recipient_id as string) || 'unknown',
                name: (status.recipient_id as string) || 'unknown',
              },
              context: { name: phoneNumberId },
              mentions: [],
              labels: [],
              metadata: {
                phoneNumberId,
                status: status.status,
                conversationId: (status.conversation as Record<string, unknown>)?.id,
              },
              rawPayload: payload,
            });
          }
        }
      }
    }

    return messages;
  }

  async deliver(
    _event: NormalizedMessage,
    message: OutboundMessage,
    config?: GatewayMetadata
  ): Promise<DeliveryResult> {
    const token = (config?.accessToken as string) || this.accessToken;
    const phoneId = (config?.phoneNumberId as string) || this.phoneNumberId;
    const to = String(message.target);

    try {
      const body: Record<string, unknown> = {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: message.body },
      };

      // Reply to a specific message if provided
      if (message.replyToMessageId) {
        body.context = { message_id: message.replyToMessageId };
      }

      const response = await fetch(`https://graph.facebook.com/${this.apiVersion}/${phoneId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error: `WhatsApp API error: ${error}` };
      }

      const result = (await response.json()) as {
        messages?: Array<{ id: string }>;
      };
      const messageId = result.messages?.[0]?.id;

      return {
        success: true,
        id: messageId,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private extractMentions(text: string | null | undefined): string[] {
    if (!text) return [];
    const mentionPattern = /(?<![<])@([a-zA-Z][a-zA-Z0-9_-]*)(?![>])/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionPattern.exec(text)) !== null) {
      mentions.push(match[1].toLowerCase());
    }
    return [...new Set(mentions)];
  }
}
