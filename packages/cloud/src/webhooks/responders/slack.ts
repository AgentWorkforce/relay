/**
 * Slack Responder
 *
 * Sends responses back to Slack via their Web API.
 * https://api.slack.com/methods
 */

import type { NormalizedEvent, WebhookResponder, WebhookResponse } from '../types.js';

/**
 * Call a Slack Web API method
 */
async function slackAPI(
  token: string,
  method: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; ts?: string; channel?: string; message?: Record<string, unknown> }> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  return response.json() as Promise<{ ok: boolean; error?: string; ts?: string; channel?: string; message?: Record<string, unknown> }>;
}

export const slackResponder: WebhookResponder = {
  id: 'slack',

  async respond(
    event: NormalizedEvent,
    response: WebhookResponse,
    config?: Record<string, unknown>
  ): Promise<{ success: boolean; id?: string; url?: string; error?: string }> {
    const botToken = config?.botToken as string || process.env.SLACK_BOT_TOKEN;

    if (!botToken) {
      return {
        success: false,
        error: 'Slack bot token not configured',
      };
    }

    try {
      // Get channel from event metadata or response target
      const channelId = response.metadata?.channel as string
        || event.metadata?.channelId as string
        || String(response.target);

      if (!channelId) {
        return {
          success: false,
          error: 'Channel ID required',
        };
      }

      switch (response.type) {
        case 'message': {
          // Post a message to a channel
          const threadTs = response.metadata?.threadTs as string
            || event.metadata?.threadTs as string
            || event.metadata?.ts as string;

          const result = await slackAPI(botToken, 'chat.postMessage', {
            channel: channelId,
            text: response.body,
            thread_ts: threadTs, // Reply in thread if available
            unfurl_links: false,
            unfurl_media: false,
          });

          if (!result.ok) {
            return {
              success: false,
              error: result.error || 'Failed to post message',
            };
          }

          return {
            success: true,
            id: result.ts,
            // Construct Slack message URL
            url: `https://slack.com/archives/${channelId}/p${result.ts?.replace('.', '')}`,
          };
        }

        case 'comment': {
          // Same as message, but explicitly in a thread
          const threadTs = String(response.target);

          const result = await slackAPI(botToken, 'chat.postMessage', {
            channel: channelId,
            text: response.body,
            thread_ts: threadTs,
            reply_broadcast: response.metadata?.broadcast === true,
          });

          if (!result.ok) {
            return {
              success: false,
              error: result.error || 'Failed to post reply',
            };
          }

          return {
            success: true,
            id: result.ts,
          };
        }

        case 'reaction': {
          // Add a reaction to a message
          const ts = String(response.target);
          const emoji = response.metadata?.emoji as string || response.body.replace(/:/g, '');

          const result = await slackAPI(botToken, 'reactions.add', {
            channel: channelId,
            timestamp: ts,
            name: emoji,
          });

          if (!result.ok && result.error !== 'already_reacted') {
            return {
              success: false,
              error: result.error || 'Failed to add reaction',
            };
          }

          return {
            success: true,
          };
        }

        case 'status': {
          // Update bot status/presence (not commonly used)
          return {
            success: false,
            error: 'Status updates not implemented for Slack',
          };
        }

        default:
          return {
            success: false,
            error: `Unknown response type: ${response.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },
};

/**
 * Helper to format a message with blocks for richer formatting
 */
export function formatSlackBlocks(
  text: string,
  options?: {
    header?: string;
    context?: string;
    actions?: Array<{ text: string; url: string }>;
  }
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  if (options?.header) {
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: options.header,
        emoji: true,
      },
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text,
    },
  });

  if (options?.context) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: options.context,
        },
      ],
    });
  }

  if (options?.actions?.length) {
    blocks.push({
      type: 'actions',
      elements: options.actions.map(action => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: action.text,
          emoji: true,
        },
        url: action.url,
      })),
    });
  }

  return blocks;
}
