import { SlackPostBackError, type SlackChannelSummary, type SlackWebApiLike } from '../types.js';

const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{2,}$/;

/**
 * Resolve a Slack channel reference to a channel object.
 * @param slack - Slack Web API client.
 * @param channel - Raw channel id or #channel-name reference.
 * @returns Resolved Slack channel summary.
 */
export async function resolveChannel(
  slack: SlackWebApiLike,
  channel: string
): Promise<SlackChannelSummary> {
  if (CHANNEL_ID_PATTERN.test(channel)) {
    return { id: channel };
  }

  const name = channel.startsWith('#') ? channel.slice(1) : channel;
  let cursor: string | undefined;

  do {
    const response = await slack.conversations.list({
      cursor,
      limit: 200,
      types: 'public_channel,private_channel',
    });

    const match = response.channels?.find((candidate) => candidate.name === name);
    if (match?.id) {
      return match;
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  throw new SlackPostBackError('channel_not_found', `Slack channel not found: ${channel}`);
}
