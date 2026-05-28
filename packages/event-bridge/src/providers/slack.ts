import type { RelayfileChangeEvent } from '@agent-relay/events';
import type { InboundContext, InboundItem, ProviderAdapter, WorkspaceFileLike } from '../types.js';

/**
 * Canonical Slack message record path written by `@relayfile/adapter-slack`:
 * `/slack/channels/<chan>/messages/<msg>/meta.json` (legacy: `message.json`).
 * The `<chan>` and `<msg>` segments are opaque (`<id>__<slug>` or id/ts tokens).
 */
const MESSAGE_PATH_RE = /^\/slack\/channels\/([^/]+)\/messages\/([^/]+)\/(?:meta|message)\.json$/;

/**
 * Options for {@link slackProvider}.
 */
export interface SlackProviderOptions {
  /**
   * Skip messages authored by bots (`subtype: 'bot_message'` or a `bot_id`).
   * Prevents the bridge from reacting to its own posted replies once Slack
   * echoes them back through the webhook. Defaults to `true`.
   */
  ignoreBotMessages?: boolean;
  /** Slack user ids to ignore, e.g. the agent's own bot user id. */
  ignoreUserIds?: string[];
}

/**
 * Slack provider adapter. Inbound: new channel messages. Outbound: a threaded
 * reply written to `.../messages/<msg>/replies/<draft>.json`, which the Slack
 * writeback adapter turns into `chat.postMessage` with `thread_ts`.
 */
export function slackProvider(options: SlackProviderOptions = {}): ProviderAdapter {
  const ignoreBots = options.ignoreBotMessages ?? true;
  const ignoreUsers = new Set(options.ignoreUserIds ?? []);

  return {
    name: 'slack',
    watch: ['/slack/channels/**'],
    scopes: ['relayfile:fs:read:/slack/**', 'relayfile:fs:write:/slack/**'],
    resolveInbound(
      event: RelayfileChangeEvent,
      file: WorkspaceFileLike | null,
      ctx: InboundContext
    ): InboundItem | null {
      if (event.action === 'deleted') {
        return null;
      }
      // Our own writeback (and any agent-authored change) must never re-trigger.
      if (event.agentId) {
        return null;
      }
      const match = MESSAGE_PATH_RE.exec(event.path);
      if (!match) {
        return null;
      }
      const channelSeg = match[1];
      const messageSeg = match[2];

      const msg = asRecord(file?.body);
      const subtype = readString(msg, 'subtype');
      if (ignoreBots && (subtype === 'bot_message' || readString(msg, 'bot_id'))) {
        return null;
      }
      const userId = readString(msg, 'user') ?? readString(msg, 'user_id');
      if (userId && ignoreUsers.has(userId)) {
        return null;
      }

      const channelName = prettySegment(channelSeg);
      const author = readAuthor(msg) ?? userId ?? 'someone';
      const text = readString(msg, 'text') ?? event.current?.title ?? event.summary?.title ?? '';

      // Reply in-thread: a draft under the message's `replies/` directory.
      const replyPath = `/slack/channels/${channelSeg}/messages/${messageSeg}/replies/draft-${ctx.replyId}.json`;

      return {
        source: `#${channelName}`,
        body: `New Slack message in #${channelName} from ${author}:\n${text || '(no text content)'}`,
        replyPath,
        serializeReply(replyText: string) {
          return {
            content: JSON.stringify({ text: replyText }),
            contentType: 'application/json',
          };
        },
      };
    },
  };
}

/** Best-effort display label for an `<id>__<slug>` path segment. */
function prettySegment(segment: string): string {
  const idx = segment.indexOf('__');
  return idx >= 0 ? segment.slice(idx + 2) : segment;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Pull a human author name from common Slack shapes. */
function readAuthor(msg: Record<string, unknown> | undefined): string | undefined {
  if (!msg) {
    return undefined;
  }
  const profile = asRecord(msg.user_profile);
  return (
    readString(msg, 'username') ?? readString(profile, 'display_name') ?? readString(profile, 'real_name')
  );
}
