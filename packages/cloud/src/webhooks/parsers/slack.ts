/**
 * Slack Webhook Parser
 *
 * Transforms Slack Events API payloads into normalized events.
 * https://api.slack.com/apis/connections/events-api
 */

import type { NormalizedEvent, WebhookParser } from '../types.js';

/**
 * Extract user mentions from Slack message text
 * Slack format: <@U12345678> or <@U12345678|username>
 */
function extractSlackMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const mentionPattern = /<@([A-Z0-9]+)(?:\|([^>]+))?>/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    // Prefer display name if available, otherwise use ID
    mentions.push(match[2] || match[1]);
  }
  return [...new Set(mentions)];
}

/**
 * Extract agent mentions from text (our custom @agent-name format)
 */
function extractAgentMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  // Match @agent-name patterns that aren't Slack user mentions
  const mentionPattern = /(?<![<])@([a-zA-Z][a-zA-Z0-9_-]*)(?![>])/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionPattern.exec(text)) !== null) {
    mentions.push(match[1].toLowerCase());
  }
  return [...new Set(mentions)];
}

/**
 * Clean Slack message text (remove user mention formatting)
 */
function cleanSlackText(text: string | null | undefined): string {
  if (!text) return '';
  // Replace <@U12345678|username> with @username
  return text.replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+>/g, '@user')
    // Replace <URL|text> with text
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    // Replace <URL> with URL
    .replace(/<([^>]+)>/g, '$1');
}

export const slackParser: WebhookParser = {
  id: 'slack',

  parse(payload: unknown): NormalizedEvent[] {
    const data = payload as Record<string, unknown>;
    const events: NormalizedEvent[] = [];

    // Handle URL verification challenge
    if (data.type === 'url_verification') {
      // This is handled separately in the router
      return [];
    }

    // Events API wrapper
    if (data.type !== 'event_callback') {
      return [];
    }

    const event = data.event as Record<string, unknown> | undefined;
    if (!event) return [];

    const eventType = event.type as string;
    const teamId = data.team_id as string || 'unknown';
    const eventId = data.event_id as string || `slack-${Date.now()}`;
    const eventTime = data.event_time as number | undefined;

    const baseEvent: Partial<NormalizedEvent> = {
      id: eventId,
      source: 'slack',
      timestamp: eventTime ? new Date(eventTime * 1000) : new Date(),
      actor: {
        id: String(event.user || 'unknown'),
        name: String(event.user || 'unknown'),
      },
      context: {
        name: teamId,
      },
      labels: [],
      mentions: [],
      metadata: {
        teamId,
        channelId: event.channel,
        channelType: event.channel_type,
      },
      rawPayload: payload,
    };

    switch (eventType) {
      case 'app_mention': {
        // Bot was mentioned in a channel
        const text = event.text as string;
        const agentMentions = extractAgentMentions(text);

        events.push({
          ...baseEvent,
          type: 'mention',
          item: {
            type: 'message',
            id: String(event.ts),
            body: cleanSlackText(text),
          },
          mentions: agentMentions.length > 0 ? agentMentions : ['lead'], // Default to lead if no specific agent
          metadata: {
            ...baseEvent.metadata,
            ts: event.ts,
            threadTs: event.thread_ts,
            userMentions: extractSlackMentions(text),
          },
        } as NormalizedEvent);
        break;
      }

      case 'message': {
        // Regular message in channel
        const text = event.text as string;
        const subtype = event.subtype as string | undefined;

        // Ignore bot messages, message changes, etc.
        if (subtype && subtype !== 'thread_broadcast') {
          break;
        }

        const agentMentions = extractAgentMentions(text);

        // Only create event if there are agent mentions
        if (agentMentions.length > 0) {
          events.push({
            ...baseEvent,
            type: 'mention',
            item: {
              type: 'message',
              id: String(event.ts),
              body: cleanSlackText(text),
            },
            mentions: agentMentions,
            metadata: {
              ...baseEvent.metadata,
              ts: event.ts,
              threadTs: event.thread_ts,
              userMentions: extractSlackMentions(text),
            },
          } as NormalizedEvent);
        }
        break;
      }

      case 'reaction_added': {
        // Reaction added to a message
        const reaction = event.reaction as string;
        const item = event.item as Record<string, unknown>;

        events.push({
          ...baseEvent,
          type: 'reaction_added',
          item: {
            type: 'message',
            id: String(item?.ts || 'unknown'),
          },
          labels: [reaction],
          metadata: {
            ...baseEvent.metadata,
            reaction,
            itemType: item?.type,
            itemChannel: item?.channel,
            itemTs: item?.ts,
          },
        } as NormalizedEvent);
        break;
      }

      case 'channel_created': {
        const channel = event.channel as Record<string, unknown>;

        events.push({
          ...baseEvent,
          type: 'channel_created',
          context: {
            name: String(channel?.name || 'unknown'),
          },
          metadata: {
            ...baseEvent.metadata,
            channelId: channel?.id,
            channelName: channel?.name,
            creator: channel?.creator,
          },
        } as NormalizedEvent);
        break;
      }

      case 'member_joined_channel': {
        events.push({
          ...baseEvent,
          type: 'member_joined',
          actor: {
            id: String(event.user),
            name: String(event.user),
          },
          metadata: {
            ...baseEvent.metadata,
            inviter: event.inviter,
          },
        } as NormalizedEvent);
        break;
      }

      default:
        // Unknown event type
        events.push({
          ...baseEvent,
          type: `slack.${eventType}`,
          metadata: {
            ...baseEvent.metadata,
            subtype: event.subtype,
          },
        } as NormalizedEvent);
    }

    return events;
  },
};
