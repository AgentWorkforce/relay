import { resolveChannel } from './resolve-channel.js';
import { resolveUser } from './resolve-user.js';
import type {
  PostMessageOutput,
  PostMessageParams,
  SlackResolutionWarning,
  SlackResolvedMention,
  SlackUserSummary,
  SlackWebApiLike,
} from '../types.js';

/**
 * Resolve Slack references and post a message.
 * @param slack - Slack Web API client.
 * @param params - Message parameters.
 * @returns Posted message metadata and soft mention-resolution warnings.
 */
export async function postMessage(
  slack: SlackWebApiLike,
  params: PostMessageParams
): Promise<PostMessageOutput> {
  const channelInput = params.channel ?? process.env.SLACK_DEFAULT_CHANNEL;
  if (!channelInput) {
    throw new Error('Slack postMessage channel is missing; provide channel or set SLACK_DEFAULT_CHANNEL.');
  }

  const channel = await resolveChannel(slack, channelInput);
  const userCache = new Map<string, SlackUserSummary>();
  const resolvedMentions: SlackResolvedMention[] = [];
  const warnings: SlackResolutionWarning[] = [];

  for (const mention of params.mentions ?? []) {
    try {
      resolvedMentions.push(await resolveUser(slack, mention, { cache: userCache }));
    } catch (error) {
      warnings.push({
        type: 'mention_unresolved',
        input: mention,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const mentionPrefix = resolvedMentions.map((mention) => `<@${mention.userId}>`).join(' ');
  const text = mentionPrefix ? `${mentionPrefix} ${params.text}` : params.text;
  const response = await slack.chat.postMessage({
    channel: channel.id,
    text,
    thread_ts: params.threadTs,
    unfurl_links: params.unfurl,
    unfurl_media: params.unfurl,
  });

  return {
    channel: response.channel ?? channel.id,
    ts: response.ts ?? '',
    text: response.message?.text ?? text,
    resolvedMentions,
    unresolvedMentions: warnings.map((warning) => warning.input),
    warnings,
  };
}
