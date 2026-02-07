/**
 * MCP tool definitions for the Headless Slack server.
 *
 * 19 tools covering the full Slack-like API surface:
 *   Registration, channels, messages, threads, DMs, reactions, search, inbox.
 *
 * Tool naming follows Slack's resource.action convention but simplified
 * for AI agent ergonomics (no dots in MCP tool names).
 *
 * Each tool handler formats output as readable text for AI agents,
 * not raw JSON — agents shouldn't have to parse structured data.
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Engine } from './engine.js';
import type { SessionState, Message, ReactionSummary } from './types.js';

// ---------------------------------------------------------------------------
// Helper: format a message for display
// ---------------------------------------------------------------------------

function fmtMessage(m: Message): string {
  const name = m.agent_name ?? m.agent_id;
  const time = new Date(m.created_at).toISOString();
  const threadInfo = m.thread_id ? ` (in thread ${m.thread_id})` : '';
  const replyInfo =
    m.reply_count && m.reply_count > 0
      ? ` [${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}]`
      : '';
  const reactionInfo = fmtReactions(m.reactions);
  return `[${time}] ${name}${threadInfo}: ${m.body}${replyInfo}${reactionInfo}\n  id: ${m.id}`;
}

function fmtReactions(reactions?: ReactionSummary[]): string {
  if (!reactions || reactions.length === 0) return '';
  const parts = reactions.map(
    (r) => `:${r.emoji}: ${r.count} (${r.agents.join(', ')})`,
  );
  return `\n  reactions: ${parts.join('  ')}`;
}

// ---------------------------------------------------------------------------
// Schema + Tool + Handler for each tool
// ---------------------------------------------------------------------------

// 1. register
const registerSchema = z.object({
  name: z.string().describe('Your agent name (e.g. "Alice", "CodeReviewer")'),
  persona: z
    .string()
    .optional()
    .describe('Optional persona description (e.g. "Backend engineer")'),
  workspace: z
    .string()
    .optional()
    .describe('Workspace name (default: "default")'),
});

const registerTool: Tool = {
  name: 'register',
  description: `Register yourself as an agent in the workspace. MUST be called before using any other tool.
Creates the workspace if it doesn't exist. Auto-joins #general channel.
Returns your agent ID, workspace info, and list of channels you're in.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Your agent name' },
      persona: { type: 'string', description: 'Optional persona description' },
      workspace: { type: 'string', description: 'Workspace name (default: "default")' },
    },
    required: ['name'],
  },
};

// 2. list_channels
const listChannelsSchema = z.object({
  include_archived: z.boolean().optional().default(false),
});

const listChannelsTool: Tool = {
  name: 'list_channels',
  description: 'List all channels in the workspace. Shows channel name, topic, and member count.',
  inputSchema: {
    type: 'object',
    properties: {
      include_archived: { type: 'boolean', description: 'Include archived channels' },
    },
  },
};

// 3. create_channel
const createChannelSchema = z.object({
  name: z.string().describe('Channel name (without #)'),
  topic: z.string().optional().describe('Channel topic'),
});

const createChannelTool: Tool = {
  name: 'create_channel',
  description: 'Create a new channel. You automatically join as owner.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Channel name (without #)' },
      topic: { type: 'string', description: 'Channel topic' },
    },
    required: ['name'],
  },
};

// 4. join_channel
const joinChannelSchema = z.object({
  channel: z.string().describe('Channel name to join'),
});

const joinChannelTool: Tool = {
  name: 'join_channel',
  description: 'Join an existing channel.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name to join' },
    },
    required: ['channel'],
  },
};

// 5. leave_channel
const leaveChannelSchema = z.object({
  channel: z.string().describe('Channel name to leave'),
});

const leaveChannelTool: Tool = {
  name: 'leave_channel',
  description: 'Leave a channel.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name to leave' },
    },
    required: ['channel'],
  },
};

// 6. invite_to_channel
const inviteToChannelSchema = z.object({
  channel: z.string().describe('Channel name'),
  agent_name: z.string().describe('Agent to invite'),
});

const inviteToChannelTool: Tool = {
  name: 'invite_to_channel',
  description: 'Invite another agent to a channel you belong to.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name' },
      agent_name: { type: 'string', description: 'Agent name to invite' },
    },
    required: ['channel', 'agent_name'],
  },
};

// 7. set_channel_topic
const setChannelTopicSchema = z.object({
  channel: z.string().describe('Channel name'),
  topic: z.string().describe('New topic'),
});

const setChannelTopicTool: Tool = {
  name: 'set_channel_topic',
  description: 'Set or update the topic of a channel.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name' },
      topic: { type: 'string', description: 'New topic' },
    },
    required: ['channel', 'topic'],
  },
};

// 8. archive_channel
const archiveChannelSchema = z.object({
  channel: z.string().describe('Channel name to archive'),
});

const archiveChannelTool: Tool = {
  name: 'archive_channel',
  description: 'Archive a channel. Archived channels are read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name to archive' },
    },
    required: ['channel'],
  },
};

// 9. post_message
const postMessageSchema = z.object({
  channel: z.string().describe('Channel name to post in'),
  text: z.string().describe('Message text. Use @agentname to mention someone.'),
});

const postMessageTool: Tool = {
  name: 'post_message',
  description: `Post a message to a channel. You must be a member.
Use @agentname to mention and notify another agent.
Returns the message ID (use it with reply_to_thread or add_reaction).`,
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name' },
      text: { type: 'string', description: 'Message text' },
    },
    required: ['channel', 'text'],
  },
};

// 10. reply_to_thread
const replyToThreadSchema = z.object({
  thread_id: z.string().describe('Message ID to reply to (starts the thread)'),
  text: z.string().describe('Reply text'),
});

const replyToThreadTool: Tool = {
  name: 'reply_to_thread',
  description: `Reply to a message, creating or continuing a thread.
Use the message ID from post_message or get_messages as the thread_id.`,
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: 'Parent message ID' },
      text: { type: 'string', description: 'Reply text' },
    },
    required: ['thread_id', 'text'],
  },
};

// 11. get_messages
const getMessagesSchema = z.object({
  channel: z.string().describe('Channel name'),
  limit: z.number().optional().default(50).describe('Max messages (default 50)'),
  before: z.string().optional().describe('Get messages before this message ID'),
  after: z.string().optional().describe('Get messages after this message ID'),
});

const getMessagesTool: Tool = {
  name: 'get_messages',
  description: `Get messages from a channel. Shows top-level messages (not thread replies).
Supports cursor-based pagination with before/after message IDs.
Also marks the channel as read for you.`,
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name' },
      limit: { type: 'number', description: 'Max messages (default 50)' },
      before: { type: 'string', description: 'Get messages before this ID' },
      after: { type: 'string', description: 'Get messages after this ID' },
    },
    required: ['channel'],
  },
};

// 12. get_thread
const getThreadSchema = z.object({
  thread_id: z.string().describe('Parent message ID of the thread'),
});

const getThreadTool: Tool = {
  name: 'get_thread',
  description: 'Get all messages in a thread (parent + replies).',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string', description: 'Parent message ID' },
    },
    required: ['thread_id'],
  },
};

// 13. send_dm
const sendDmSchema = z.object({
  to: z.string().describe('Agent name to DM'),
  text: z.string().describe('Message text'),
});

const sendDmTool: Tool = {
  name: 'send_dm',
  description: `Send a direct message to another agent.
Creates a DM conversation if one doesn't exist.`,
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Agent name to DM' },
      text: { type: 'string', description: 'Message text' },
    },
    required: ['to', 'text'],
  },
};

// 14. get_dms
const getDmsSchema = z.object({
  with_agent: z.string().describe('Agent name to get DM history with'),
  limit: z.number().optional().default(50),
  before: z.string().optional(),
});

const getDmsTool: Tool = {
  name: 'get_dms',
  description: 'Get direct message history with another agent. Also marks DMs as read.',
  inputSchema: {
    type: 'object',
    properties: {
      with_agent: { type: 'string', description: 'Agent name' },
      limit: { type: 'number', description: 'Max messages (default 50)' },
      before: { type: 'string', description: 'Get messages before this ID' },
    },
    required: ['with_agent'],
  },
};

// 15. add_reaction
const addReactionSchema = z.object({
  message_id: z.string().describe('Message ID to react to'),
  emoji: z.string().describe('Emoji name (e.g. "thumbsup", "heart", "rocket", "eyes")'),
});

const addReactionTool: Tool = {
  name: 'add_reaction',
  description: `Add an emoji reaction to a message.
Common emoji: thumbsup, thumbsdown, heart, rocket, eyes, check, x, wave, fire, tada`,
  inputSchema: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Message ID' },
      emoji: { type: 'string', description: 'Emoji name (e.g. "thumbsup")' },
    },
    required: ['message_id', 'emoji'],
  },
};

// 16. remove_reaction
const removeReactionSchema = z.object({
  message_id: z.string().describe('Message ID'),
  emoji: z.string().describe('Emoji name to remove'),
});

const removeReactionTool: Tool = {
  name: 'remove_reaction',
  description: 'Remove your emoji reaction from a message.',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: 'Message ID' },
      emoji: { type: 'string', description: 'Emoji name to remove' },
    },
    required: ['message_id', 'emoji'],
  },
};

// 17. search_messages
const searchMessagesSchema = z.object({
  query: z.string().describe('Search query (supports FTS5 syntax: AND, OR, NOT, "exact phrase")'),
  channel: z.string().optional().describe('Limit search to a specific channel'),
  from: z.string().optional().describe('Limit search to messages from a specific agent'),
  limit: z.number().optional().default(20),
});

const searchMessagesTool: Tool = {
  name: 'search_messages',
  description: `Search messages across the workspace using full-text search.
Supports FTS5 query syntax:
  - Simple: "deployment error"
  - AND: "api AND error"
  - OR: "bug OR issue"
  - NOT: "deploy NOT staging"
  - Exact phrase: '"exact phrase"'`,
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      channel: { type: 'string', description: 'Limit to channel (optional)' },
      from: { type: 'string', description: 'Limit to agent (optional)' },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['query'],
  },
};

// 18. check_inbox
const checkInboxSchema = z.object({});

const checkInboxTool: Tool = {
  name: 'check_inbox',
  description: `Check your inbox for unread messages, mentions, and DMs.
IMPORTANT: Call this regularly to stay up to date with conversations.
Returns: unread channel counts, messages where you were @mentioned, and unread DMs.`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

// 19. list_agents
const listAgentsSchema = z.object({
  status: z
    .enum(['online', 'offline', 'away', 'all'])
    .optional()
    .default('all')
    .describe('Filter by status'),
});

const listAgentsTool: Tool = {
  name: 'list_agents',
  description: 'List all agents in the workspace. Filter by status (online/offline/away/all).',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['online', 'offline', 'away', 'all'],
        description: 'Filter by status (default: all)',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// All tools list
// ---------------------------------------------------------------------------

export const ALL_TOOLS: Tool[] = [
  registerTool,
  listChannelsTool,
  createChannelTool,
  joinChannelTool,
  leaveChannelTool,
  inviteToChannelTool,
  setChannelTopicTool,
  archiveChannelTool,
  postMessageTool,
  replyToThreadTool,
  getMessagesTool,
  getThreadTool,
  sendDmTool,
  getDmsTool,
  addReactionTool,
  removeReactionTool,
  searchMessagesTool,
  checkInboxTool,
  listAgentsTool,
];

// ---------------------------------------------------------------------------
// Tool handler dispatcher
// ---------------------------------------------------------------------------

export async function handleToolCall(
  engine: Engine,
  session: SessionState,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
  try {
    // Registration doesn't require existing session
    if (toolName === 'register') {
      const input = registerSchema.parse(args);
      const result = engine.register(input.name, input.persona, input.workspace);
      session.agentId = result.agent.id;
      session.agentName = result.agent.name;
      session.workspaceId = result.workspace.id;

      const channelList = result.channels
        .map((c) => `  #${c.name}${c.topic ? ` — ${c.topic}` : ''}`)
        .join('\n');

      return {
        text: `Registered as "${result.agent.name}" in workspace "${result.workspace.name}"\nAgent ID: ${result.agent.id}\n\nYour channels:\n${channelList}\n\nTip: Call check_inbox regularly to see new messages and mentions.`,
      };
    }

    // All other tools require registration
    if (!session.agentId) {
      return {
        text: 'Error: You must call the "register" tool first to identify yourself.',
        isError: true,
      };
    }

    const agentId = session.agentId;

    switch (toolName) {
      case 'list_channels': {
        const input = listChannelsSchema.parse(args);
        const channels = engine.listChannels(agentId, input.include_archived);
        if (channels.length === 0) return { text: 'No channels found.' };
        const list = channels
          .map(
            (c) =>
              `#${c.name}${c.topic ? ` — ${c.topic}` : ''} (${c.member_count ?? '?'} members)${c.is_archived ? ' [archived]' : ''}`,
          )
          .join('\n');
        return { text: `Channels:\n${list}` };
      }

      case 'create_channel': {
        const input = createChannelSchema.parse(args);
        const channel = engine.createChannel(agentId, input.name, input.topic);
        return {
          text: `Created channel #${channel.name}${channel.topic ? ` — ${channel.topic}` : ''}`,
        };
      }

      case 'join_channel': {
        const input = joinChannelSchema.parse(args);
        const channel = engine.joinChannel(agentId, input.channel);
        return { text: `Joined #${channel.name}` };
      }

      case 'leave_channel': {
        const input = leaveChannelSchema.parse(args);
        engine.leaveChannel(agentId, input.channel);
        return { text: `Left #${input.channel}` };
      }

      case 'invite_to_channel': {
        const input = inviteToChannelSchema.parse(args);
        engine.inviteToChannel(agentId, input.channel, input.agent_name);
        return { text: `Invited ${input.agent_name} to #${input.channel}` };
      }

      case 'set_channel_topic': {
        const input = setChannelTopicSchema.parse(args);
        engine.setChannelTopic(agentId, input.channel, input.topic);
        return { text: `Set topic of #${input.channel} to: ${input.topic}` };
      }

      case 'archive_channel': {
        const input = archiveChannelSchema.parse(args);
        engine.archiveChannel(agentId, input.channel);
        return { text: `Archived #${input.channel}` };
      }

      case 'post_message': {
        const input = postMessageSchema.parse(args);
        const msg = engine.postMessage(agentId, input.channel, input.text);
        return {
          text: `Message posted to #${input.channel}\n${fmtMessage({ ...msg, agent_name: session.agentName ?? undefined })}`,
        };
      }

      case 'reply_to_thread': {
        const input = replyToThreadSchema.parse(args);
        const msg = engine.replyToThread(agentId, input.thread_id, input.text);
        return {
          text: `Reply posted to thread ${input.thread_id}\n${fmtMessage({ ...msg, agent_name: session.agentName ?? undefined })}`,
        };
      }

      case 'get_messages': {
        const input = getMessagesSchema.parse(args);
        const messages = engine.getMessages(agentId, input.channel, {
          limit: input.limit,
          before: input.before,
          after: input.after,
        });
        if (messages.length === 0) return { text: `No messages in #${input.channel}` };
        const formatted = messages.map(fmtMessage).join('\n\n');
        return { text: `#${input.channel} (${messages.length} messages):\n\n${formatted}` };
      }

      case 'get_thread': {
        const input = getThreadSchema.parse(args);
        const messages = engine.getThread(agentId, input.thread_id);
        if (messages.length === 0) return { text: 'Thread not found.' };
        const formatted = messages.map(fmtMessage).join('\n\n');
        return { text: `Thread ${input.thread_id} (${messages.length} messages):\n\n${formatted}` };
      }

      case 'send_dm': {
        const input = sendDmSchema.parse(args);
        const msg = engine.sendDm(agentId, input.to, input.text);
        return {
          text: `DM sent to ${input.to}\n${fmtMessage({ ...msg, agent_name: session.agentName ?? undefined })}`,
        };
      }

      case 'get_dms': {
        const input = getDmsSchema.parse(args);
        const messages = engine.getDms(agentId, input.with_agent, {
          limit: input.limit,
          before: input.before,
        });
        if (messages.length === 0) return { text: `No DMs with ${input.with_agent}` };
        const formatted = messages.map(fmtMessage).join('\n\n');
        return { text: `DMs with ${input.with_agent} (${messages.length} messages):\n\n${formatted}` };
      }

      case 'add_reaction': {
        const input = addReactionSchema.parse(args);
        const reactions = engine.addReaction(agentId, input.message_id, input.emoji);
        const summary = reactions
          .map((r) => `:${r.emoji}: ${r.count}`)
          .join('  ');
        return { text: `Added :${input.emoji}: reaction\nReactions: ${summary}` };
      }

      case 'remove_reaction': {
        const input = removeReactionSchema.parse(args);
        engine.removeReaction(agentId, input.message_id, input.emoji);
        return { text: `Removed :${input.emoji}: reaction` };
      }

      case 'search_messages': {
        const input = searchMessagesSchema.parse(args);
        const messages = engine.searchMessages(agentId, {
          query: input.query,
          channel_id: input.channel,
          agent_id: input.from,
          limit: input.limit,
        });
        if (messages.length === 0) return { text: `No results for "${input.query}"` };
        const formatted = messages.map(fmtMessage).join('\n\n');
        return { text: `Search results for "${input.query}" (${messages.length}):\n\n${formatted}` };
      }

      case 'check_inbox': {
        checkInboxSchema.parse(args);
        const inbox = engine.checkInbox(agentId);

        const parts: string[] = [];

        if (inbox.unread_channels.length > 0) {
          const channels = inbox.unread_channels
            .map((u) => `  #${u.channel_name}: ${u.unread_count} unread`)
            .join('\n');
          parts.push(`Unread channels:\n${channels}`);
        }

        if (inbox.unread_dms.length > 0) {
          const dms = inbox.unread_dms
            .map((u) => `  ${u.channel_name}: ${u.unread_count} unread`)
            .join('\n');
          parts.push(`Unread DMs:\n${dms}`);
        }

        if (inbox.mentions.length > 0) {
          const mentions = inbox.mentions.map(fmtMessage).join('\n\n');
          parts.push(`Mentions:\n${mentions}`);
        }

        if (parts.length === 0) {
          return { text: 'Inbox is empty — no unread messages or mentions.' };
        }

        return { text: parts.join('\n\n') };
      }

      case 'list_agents': {
        const input = listAgentsSchema.parse(args);
        const agents = engine.listAgents(agentId, input.status);
        if (agents.length === 0) return { text: 'No agents found.' };
        const list = agents
          .map(
            (a) =>
              `${a.name} [${a.status}]${a.persona ? ` — ${a.persona}` : ''}`,
          )
          .join('\n');
        return { text: `Agents:\n${list}` };
      }

      default:
        return { text: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `Error: ${message}`, isError: true };
  }
}
