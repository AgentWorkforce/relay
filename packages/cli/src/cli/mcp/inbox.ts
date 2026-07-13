/** Tools whose results should never be augmented with piggybacked inbox state. */
export const SKIP_PIGGYBACK = new Set([
  'check_inbox',
  'create_workspace',
  'set_workspace_key',
  'register_agent',
]);

/**
 * Render an inbox payload into a compact human-readable summary appended to tool
 * results. When `selfName` is provided, the agent's own mentions, DMs, and
 * reactions are filtered out. Returns an empty string when there is nothing pending.
 */
export function formatInbox(inbox: any, selfName?: string | null): string {
  const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase();
  const selfNorm = selfName ? norm(selfName) : null;
  const isSelf = (name: string) => selfNorm != null && norm(name) === selfNorm;
  const lines = ['--- Pending Messages ---'];

  if (inbox.unreadChannels?.length) {
    lines.push('Unread channels:');
    for (const ch of inbox.unreadChannels) {
      lines.push(`  #${ch.channelName}: ${ch.unreadCount} unread`);
    }
  }

  const mentions = selfNorm ? inbox.mentions?.filter((m: any) => !isSelf(m.agentName)) : inbox.mentions;
  if (mentions?.length) {
    lines.push('Mentions:');
    for (const m of mentions) {
      lines.push(`  @${m.agentName} in #${m.channelName}: "${m.text}"`);
    }
  }

  const dms = selfNorm ? inbox.unreadDms?.filter((dm: any) => !isSelf(dm.from)) : inbox.unreadDms;
  if (dms?.length) {
    lines.push('Unread DMs:');
    for (const dm of dms) {
      lines.push(`  From ${dm.from}: ${dm.unreadCount} unread`);
    }
  }

  const reactions = selfNorm
    ? inbox.recentReactions?.filter((reaction: any) => !isSelf(reaction.agentName))
    : inbox.recentReactions;
  if (reactions?.length) {
    lines.push('Reactions (informational; no response required):');
    for (const reaction of reactions) {
      lines.push(
        `  :${reaction.emoji}: on your message in #${reaction.channelName} by @${reaction.agentName}`
      );
    }
  }

  return lines.length === 1 ? '' : lines.join('\n');
}
