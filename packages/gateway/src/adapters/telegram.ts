/**
 * Telegram Surface Adapter
 *
 * Implements SurfaceAdapter for the Telegram Bot API.
 * - verify(): X-Telegram-Bot-Api-Secret-Token header comparison
 * - receive(): Parses Telegram Bot API Update objects
 * - deliver(): Sends via Telegram Bot API /sendMessage
 */

import type {
  SurfaceAdapter,
  SignatureConfig,
  HeaderMap,
  NormalizedMessage,
  OutboundMessage,
  DeliveryResult,
  GatewayMetadata,
} from '../types.js';

export interface TelegramAdapterOptions {
  botToken: string;
  webhookSecretToken: string;
}

export class TelegramAdapter implements SurfaceAdapter {
  readonly type = 'telegram' as const;
  readonly signature: SignatureConfig = {
    header: 'x-telegram-bot-api-secret-token',
    algorithm: 'token',
    secretEnvVar: 'TELEGRAM_WEBHOOK_SECRET',
  };

  private botToken: string;
  private webhookSecretToken: string;

  constructor(options: TelegramAdapterOptions) {
    this.botToken = options.botToken;
    this.webhookSecretToken = options.webhookSecretToken;
  }

  verify(_payload: string, headers: HeaderMap): boolean {
    const token = headers['x-telegram-bot-api-secret-token'] as string | undefined;
    if (!token) return false;
    return token === this.webhookSecretToken;
  }

  receive(payload: unknown, _headers: HeaderMap): NormalizedMessage[] {
    const update = payload as Record<string, unknown>;
    const messages: NormalizedMessage[] = [];

    const updateId = update.update_id as number;

    // Handle regular messages
    const msg =
      (update.message as Record<string, unknown>) || (update.edited_message as Record<string, unknown>);

    if (msg) {
      const chat = msg.chat as Record<string, unknown>;
      const from = msg.from as Record<string, unknown> | undefined;
      const text = msg.text as string | undefined;

      const isEdited = !!update.edited_message;
      const isGroup = chat.type === 'group' || chat.type === 'supergroup';

      // Check for bot commands
      const entities = msg.entities as Array<Record<string, unknown>> | undefined;
      const hasBotCommand = entities?.some((e) => e.type === 'bot_command') ?? false;

      let eventType = isEdited ? 'message_edited' : 'message';
      if (hasBotCommand) eventType = 'command';

      // Extract mentions from entities
      const mentions = this.extractMentions(text, entities);

      messages.push({
        id: `tg-${updateId}`,
        source: 'telegram',
        type: eventType,
        timestamp: msg.date ? new Date((msg.date as number) * 1000) : new Date(),
        actor: {
          id: String(from?.id || 'unknown'),
          name: (from?.first_name as string) || (from?.username as string) || 'unknown',
          handle: from?.username as string | undefined,
        },
        context: {
          name: (chat.title as string) || String(chat.id),
          channel: String(chat.id),
          conversationId: String(chat.id),
          threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
        },
        item: {
          type: 'message',
          id: msg.message_id as number,
          body: text || `[${msg.photo ? 'photo' : msg.document ? 'document' : 'media'}]`,
        },
        mentions,
        labels: isGroup ? ['group'] : ['private'],
        metadata: {
          chatId: chat.id,
          chatType: chat.type,
          messageId: msg.message_id,
          isEdited,
          replyToMessageId: (msg.reply_to_message as Record<string, unknown>)?.message_id,
        },
        rawPayload: payload,
      });
    }

    // Handle callback queries (inline button presses)
    const callbackQuery = update.callback_query as Record<string, unknown> | undefined;
    if (callbackQuery) {
      const from = callbackQuery.from as Record<string, unknown>;
      const cbMessage = callbackQuery.message as Record<string, unknown> | undefined;
      const chat = cbMessage?.chat as Record<string, unknown> | undefined;

      messages.push({
        id: `tg-cb-${callbackQuery.id}`,
        source: 'telegram',
        type: 'callback_query',
        timestamp: new Date(),
        actor: {
          id: String(from?.id || 'unknown'),
          name: (from?.first_name as string) || 'unknown',
          handle: from?.username as string | undefined,
        },
        context: {
          name: (chat?.title as string) || String(chat?.id || 'unknown'),
          channel: chat ? String(chat.id) : undefined,
        },
        item: {
          type: 'message',
          id: (cbMessage?.message_id as number) || 0,
          body: (callbackQuery.data as string) || '',
        },
        mentions: [],
        labels: ['callback'],
        metadata: {
          callbackQueryId: callbackQuery.id,
          callbackData: callbackQuery.data,
          chatId: chat?.id,
        },
        rawPayload: payload,
      });
    }

    return messages;
  }

  async deliver(
    event: NormalizedMessage,
    message: OutboundMessage,
    config?: GatewayMetadata
  ): Promise<DeliveryResult> {
    const token = (config?.botToken as string) || this.botToken;
    const chatId =
      (message.metadata?.chatId as string | number) ||
      (event.metadata?.chatId as string | number) ||
      message.target;

    try {
      switch (message.type) {
        case 'message':
        case 'comment': {
          const body: Record<string, unknown> = {
            chat_id: chatId,
            text: message.body,
            parse_mode: 'Markdown',
          };

          // Reply to specific message
          if (message.replyToMessageId) {
            body.reply_to_message_id = Number(message.replyToMessageId);
          } else if (message.type === 'comment' && message.target) {
            body.reply_to_message_id = Number(message.target);
          }

          const result = await this.telegramAPI(token, 'sendMessage', body);

          if (!result.ok) {
            return {
              success: false,
              error: result.description || 'Failed to send message',
            };
          }

          return {
            success: true,
            id: String(result.result?.message_id),
          };
        }

        case 'reaction': {
          const emoji = (message.metadata?.emoji as string) || message.body;
          const messageId = Number(message.target);

          const result = await this.telegramAPI(token, 'setMessageReaction', {
            chat_id: chatId,
            message_id: messageId,
            reaction: [{ type: 'emoji', emoji }],
          });

          if (!result.ok) {
            return {
              success: false,
              error: result.description || 'Failed to set reaction',
            };
          }
          return { success: true };
        }

        default:
          return {
            success: false,
            error: `Unsupported delivery type: ${message.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async telegramAPI(
    token: string,
    method: string,
    body: Record<string, unknown>
  ): Promise<{
    ok: boolean;
    description?: string;
    result?: Record<string, unknown>;
  }> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return response.json() as Promise<{
      ok: boolean;
      description?: string;
      result?: Record<string, unknown>;
    }>;
  }

  private extractMentions(
    text: string | null | undefined,
    entities: Array<Record<string, unknown>> | undefined
  ): string[] {
    if (!text || !entities) return [];

    const mentions: string[] = [];
    for (const entity of entities) {
      if (entity.type === 'mention') {
        const offset = entity.offset as number;
        const length = entity.length as number;
        const mention = text.slice(offset + 1, offset + length); // Skip @
        mentions.push(mention.toLowerCase());
      }
    }

    // Also extract @agent-name patterns
    const mentionPattern = /(?<![<])@([a-zA-Z][a-zA-Z0-9_-]*)(?![>])/g;
    let match;
    while ((match = mentionPattern.exec(text)) !== null) {
      const m = match[1].toLowerCase();
      if (!mentions.includes(m)) mentions.push(m);
    }

    return [...new Set(mentions)];
  }
}
