import type { SlackResolvedMention, SlackUserSummary, SlackWebApiLike } from '../types.js';

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

  if (isSlackUserId(normalized)) {
    return { input: mention, userId: normalized };
  }

  if (isEmailCandidate(normalized)) {
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

function isSlackUserId(value: string): boolean {
  if (value.length < 3) return false;
  if (value[0] !== 'U' && value[0] !== 'W') return false;

  for (let i = 1; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isUppercase = code >= 65 && code <= 90;
    if (!isDigit && !isUppercase) return false;
  }

  return true;
}

function isEmailCandidate(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;

  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot < domain.length - 1 && !hasAsciiWhitespace(value);
}

function hasAsciiWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32) {
      return true;
    }
  }

  return false;
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
