import type { SlackResolvedMention, SlackUserSummary, SlackWebApiLike } from '../types.js';

const USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ResolveUserOptions {
  cache?: Map<string, SlackUserSummary>;
}

/**
 * Resolve a Slack user mention to a user id.
 * @param slack - Slack Web API client.
 * @param mention - Raw user id, @email@example.com, or @handle reference.
 * @param options - Optional user cache.
 * @returns Resolved mention record.
 */
export async function resolveUser(
  slack: SlackWebApiLike,
  mention: string,
  options: ResolveUserOptions = {}
): Promise<SlackResolvedMention> {
  const normalized = mention.startsWith('@') ? mention.slice(1) : mention;

  if (USER_ID_PATTERN.test(normalized)) {
    return { input: mention, userId: normalized };
  }

  if (EMAIL_PATTERN.test(normalized)) {
    const response = await slack.users.lookupByEmail({ email: normalized });
    const userId = response.user?.id;
    if (!userId) {
      throw new Error(`Slack user not found for email: ${mention}`);
    }
    if (response.user) {
      rememberUser(options.cache, response.user);
    }
    return { input: mention, userId };
  }

  const cache = options.cache ?? new Map<string, SlackUserSummary>();
  let cached = cache.get(normalized.toLowerCase());
  if (!cached) {
    await populateUserCache(slack, cache);
    cached = cache.get(normalized.toLowerCase());
  }
  if (cached?.id) {
    return { input: mention, userId: cached.id };
  }

  throw new Error(`Slack user not found for handle: ${mention}`);
}

async function populateUserCache(
  slack: SlackWebApiLike,
  cache: Map<string, SlackUserSummary>
): Promise<void> {
  let cursor: string | undefined;

  do {
    const response = await slack.users.list({ cursor, limit: 200 });
    for (const user of response.members ?? []) {
      rememberUser(cache, user);
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

function rememberUser(cache: Map<string, SlackUserSummary> | undefined, user: SlackUserSummary): void {
  if (!cache) return;
  for (const key of userKeys(user)) {
    cache.set(key.toLowerCase(), user);
  }
}

function userKeys(user: SlackUserSummary): string[] {
  return [
    user.id,
    user.name,
    user.realName,
    user.profile?.email,
    user.profile?.displayName,
    user.profile?.realName,
  ].filter((value): value is string => Boolean(value));
}
