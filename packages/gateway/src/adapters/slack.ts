/**
 * Slack Surface Adapter
 *
 * Implements SurfaceAdapter for Slack Events API and Web API.
 * - verify(): Slack v0 HMAC-SHA256 signature verification
 * - receive(): Parses app_mention, message, reaction events into NormalizedMessage[]
 * - deliver(): Posts via Slack Web API (chat.postMessage, reactions.add)
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

export interface SlackAdapterOptions {
  botToken: string;
  signingSecret: string;
}

/**
 * Extract agent mentions from text (@agent-name patterns, not Slack user mentions)
 */
function extractAgentMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const mentionPattern = /(?<![<])@([a-zA-Z][a-zA-Z0-9_-]*)(?![>])/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[1].toLowerCase());
  }
  return [...new Set(mentions)];
}

/**
 * Clean Slack message text (remove formatting)
 */
function cleanSlackText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+>/g, '@user')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1');
}

/**
 * Call the Slack Web API
 */
async function slackAPI(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; ts?: string; channel?: string }> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  return response.json() as Promise<{ ok: boolean; error?: string; ts?: string; channel?: string }>;
}

export class SlackAdapter implements SurfaceAdapter {
  readonly type = 'slack' as const;
  readonly signature: SignatureConfig = {
    header: 'x-slack-signature',
    algorithm: 'slack-v0',
    secretEnvVar: 'SLACK_SIGNING_SECRET',
  };

  private botToken: string;
  private signingSecret: string;

  constructor(options: SlackAdapterOptions) {
    this.botToken = options.botToken;
    this.signingSecret = options.signingSecret;
  }

  verify(payload: string, headers: HeaderMap): boolean {
    const signature = headers['x-slack-signature'] as string | undefined;
    const timestamp = headers['x-slack-request-timestamp'] as string | undefined;

    if (!signature || !timestamp) return false;

    // Reject requests older than 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

    const sigBasestring = `v0:${timestamp}:${payload}`;
    const expected =
      'v0=' + crypto.createHmac('sha256', this.signingSecret).update(sigBasestring).digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  receive(payload: unknown, _headers: HeaderMap): NormalizedMessage[] {
    const data = payload as Record<string, unknown>;
    const messages: NormalizedMessage[] = [];

    // URL verification is handled outside (return challenge)
    if (data.type === 'url_verification') return [];
    if (data.type !== 'event_callback') return [];

    const event = data.event as Record<string, unknown> | undefined;
    if (!event) return [];

    const eventType = event.type as string;
    const teamId = (data.team_id as string) || 'unknown';
    const eventId = (data.event_id as string) || `slack-${Date.now()}`;
    const eventTime = data.event_time as number | undefined;

    const base: Omit<NormalizedMessage, 'type' | 'mentions'> = {
      id: eventId,
      source: 'slack',
      timestamp: eventTime ? new Date(eventTime * 1000) : new Date(),
      actor: {
        id: String(event.user || 'unknown'),
        name: String(event.user || 'unknown'),
      },
      context: {
        name: teamId,
        channel: event.channel as string | undefined,
      },
      labels: [],
      metadata: {
        teamId,
        channelId: event.channel,
        channelType: event.channel_type,
        ts: event.ts,
        threadTs: event.thread_ts,
      },
      rawPayload: payload,
    };

    switch (eventType) {
      case 'app_mention': {
        const text = event.text as string;
        const agentMentions = extractAgentMentions(text);
        messages.push({
          ...base,
          type: 'mention',
          item: {
            type: 'message',
            id: String(event.ts),
            body: cleanSlackText(text),
          },
          mentions: agentMentions.length > 0 ? agentMentions : ['lead'],
        });
        break;
      }

      case 'message': {
        const text = event.text as string;
        const subtype = event.subtype as string | undefined;
        if (subtype && subtype !== 'thread_broadcast') break;

        const agentMentions = extractAgentMentions(text);
        if (agentMentions.length > 0) {
          messages.push({
            ...base,
            type: 'mention',
            item: {
              type: 'message',
              id: String(event.ts),
              body: cleanSlackText(text),
            },
            mentions: agentMentions,
          });
        }
        break;
      }

      case 'reaction_added': {
        const reaction = event.reaction as string;
        const item = event.item as Record<string, unknown>;
        messages.push({
          ...base,
          type: 'reaction_added',
          item: {
            type: 'message',
            id: String(item?.ts || 'unknown'),
          },
          labels: [reaction],
          mentions: [],
        });
        break;
      }

      default:
        messages.push({
          ...base,
          type: `slack.${eventType}`,
          mentions: [],
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

    const channelId =
      (message.metadata?.channel as string) ||
      (event.metadata?.channelId as string) ||
      String(message.target);

    if (!channelId) {
      return { success: false, error: 'Channel ID required' };
    }

    try {
      switch (message.type) {
        case 'message': {
          const threadTs =
            (message.metadata?.threadTs as string) ||
            (event.metadata?.threadTs as string) ||
            (event.metadata?.ts as string);

          const result = await slackAPI(token, 'chat.postMessage', {
            channel: channelId,
            text: message.body,
            thread_ts: threadTs,
            unfurl_links: false,
            unfurl_media: false,
          });

          if (!result.ok) {
            return { success: false, error: result.error || 'Failed to post message' };
          }

          return {
            success: true,
            id: result.ts,
            url: `https://slack.com/archives/${channelId}/p${result.ts?.replace('.', '')}`,
          };
        }

        case 'comment': {
          const threadTs = String(message.target);
          const result = await slackAPI(token, 'chat.postMessage', {
            channel: channelId,
            text: message.body,
            thread_ts: threadTs,
            reply_broadcast: message.metadata?.broadcast === true,
          });

          if (!result.ok) {
            return { success: false, error: result.error || 'Failed to post reply' };
          }
          return { success: true, id: result.ts };
        }

        case 'reaction': {
          const ts = String(message.target);
          const emoji = (message.metadata?.emoji as string) || message.body.replace(/:/g, '');

          const result = await slackAPI(token, 'reactions.add', {
            channel: channelId,
            timestamp: ts,
            name: emoji,
          });

          if (!result.ok && result.error !== 'already_reacted') {
            return { success: false, error: result.error || 'Failed to add reaction' };
          }
          return { success: true };
        }

        default:
          return { success: false, error: `Unsupported delivery type: ${message.type}` };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
