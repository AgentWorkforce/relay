import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { jsonContent, jsonResult, textContent } from './tool-results.js';
import { identityOverrideInputShape, messageResult } from './tool-shapes.js';
import type { AgentClientLike } from './types.js';

function resolveEmoji(input: string): string {
  const normalized = input.trim().replace(/^:/, '').replace(/:$/, '').toLowerCase();
  const aliases: Record<string, string> = {
    '+1': '👍',
    thumbsup: '👍',
    thumbs_up: '👍',
    check: '✅',
    white_check_mark: '✅',
    rocket: '🚀',
    eyes: '👀',
    heart: '❤️',
    clap: '👏',
  };
  return aliases[normalized] ?? input;
}

/**
 * Register the channel, message, thread, DM, reaction, search, and inbox MCP
 * tools. These all act through a single agent client resolved per-call from the
 * optional `as` identity override.
 */
export function registerMessagingTools(
  server: McpServer,
  getAgentClient: (asIdentity?: string) => AgentClientLike
): void {
  server.registerTool(
    'create_channel',
    {
      title: 'Create Channel',
      description: 'Create a new workspace channel.',
      inputSchema: {
        name: z.string().describe('Unique channel name'),
        topic: z.string().optional().describe('Optional channel topic'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, topic, as }) => jsonContent(await getAgentClient(as).channels.create({ name, topic }))
  );

  server.registerTool(
    'list_channels',
    {
      title: 'List Channels',
      description: 'List channels available in the workspace.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Include archived channels'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        channels: z.array(z.object({}).passthrough()).describe('Channels'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ include_archived, as }) => {
      const channels = await getAgentClient(as).channels.list(
        include_archived ? { includeArchived: include_archived } : undefined
      );
      return jsonContent({ channels });
    }
  );

  server.registerTool(
    'join_channel',
    {
      title: 'Join Channel',
      description: 'Join an existing channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as }) => {
      await getAgentClient(as).channels.join(channel);
      return textContent(`Joined channel #${channel}`);
    }
  );

  server.registerTool(
    'leave_channel',
    {
      title: 'Leave Channel',
      description: 'Leave a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as }) => {
      await getAgentClient(as).channels.leave(channel);
      return textContent(`Left channel #${channel}`);
    }
  );

  server.registerTool(
    'invite_to_channel',
    {
      title: 'Invite to Channel',
      description: 'Invite another agent to a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        agent: z.string().describe('Agent name to invite'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, agent, as }) => {
      await getAgentClient(as).channels.invite(channel, agent);
      return textContent(`Invited ${agent} to #${channel}`);
    }
  );

  server.registerTool(
    'set_channel_topic',
    {
      title: 'Set Channel Topic',
      description: 'Update a channel topic.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        topic: z.string().describe('New topic'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, topic, as }) => jsonContent(await getAgentClient(as).channels.setTopic(channel, topic))
  );

  server.registerTool(
    'archive_channel',
    {
      title: 'Archive Channel',
      description: 'Archive a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, as }) => {
      await getAgentClient(as).channels.archive(channel);
      return textContent(`Archived channel #${channel}`);
    }
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post Message',
      description: 'Post a new message to a channel as the current agent.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        text: z.string().describe('Message text'),
        attachments: z.array(z.string()).optional().describe('File attachment IDs'),
        mode: z.enum(['wait', 'steer']).optional().describe('Delivery mode'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ channel, text, attachments, mode, as }) =>
      jsonContent(await getAgentClient(as).send(channel, text, { attachments, mode }))
  );

  server.registerTool(
    'list_messages',
    {
      title: 'Get Messages',
      description: 'Retrieve message history from a channel.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        limit: z.number().optional().describe('Maximum messages to return'),
        before: z.string().optional().describe('Older-than cursor'),
        after: z.string().optional().describe('Newer-than cursor'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        messages: z.array(z.object({}).passthrough()).describe('Messages'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ channel, limit, before, after, as }) => {
      const messages = await getAgentClient(as).messages(channel, { limit, before, after });
      return jsonContent({ messages });
    }
  );

  server.registerTool(
    'reply_to_thread',
    {
      title: 'Reply to Thread',
      description: 'Reply to an existing message thread.',
      inputSchema: {
        message_id: z.string().describe('Parent message ID'),
        text: z.string().describe('Reply text'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ message_id, text, as }) => jsonContent(await getAgentClient(as).reply(message_id, text))
  );

  server.registerTool(
    'get_message_thread',
    {
      title: 'Get Thread',
      description: 'Retrieve a message thread.',
      inputSchema: {
        message_id: z.string().describe('Parent message ID'),
        limit: z.number().optional().describe('Maximum replies to return'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, limit, as }) =>
      jsonContent(await getAgentClient(as).thread(message_id, limit ? { limit } : undefined))
  );

  server.registerTool(
    'send_dm',
    {
      title: 'Send Direct Message',
      description: 'Send a private direct message to another agent.',
      inputSchema: {
        to: z.string().describe('Recipient agent name'),
        text: z.string().describe('DM text'),
        mode: z.enum(['wait', 'steer']).optional().describe('Delivery mode'),
        attachments: z.array(z.string()).optional().describe('File attachment IDs'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ to, text, mode, attachments, as }) =>
      jsonContent(await getAgentClient(as).dm(to, text, { mode, attachments }))
  );

  server.registerTool(
    'list_dms',
    {
      title: 'List DM Conversations',
      description: 'List direct message conversations for the current agent.',
      inputSchema: {
        ...identityOverrideInputShape,
      },
      outputSchema: {
        conversations: z.array(z.object({}).passthrough()).describe('DM conversations'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ as }) => jsonContent({ conversations: await getAgentClient(as).dms.conversations() })
  );

  server.registerTool(
    'send_group_dm',
    {
      title: 'Send Group DM',
      description: 'Create a group DM and send the first message.',
      inputSchema: {
        participants: z.array(z.string()).describe('Participant agent names'),
        name: z.string().optional().describe('Optional group name'),
        text: z.string().describe('Initial message'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ participants, name, text, as }) => {
      const client = getAgentClient(as);
      const conversation = await client.dms.createGroup({ participants, name });
      const message = await client.dms.sendMessage(conversation.id, text);
      return jsonContent({ conversation, message });
    }
  );

  server.registerTool(
    'add_reaction',
    {
      title: 'Add Reaction',
      description: 'Add an emoji reaction to a message.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        emoji: z.string().describe('Emoji character or shortcode'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, emoji, as }) => {
      const resolved = resolveEmoji(emoji);
      await getAgentClient(as).react(message_id, resolved);
      return textContent(`Reacted with ${resolved}`);
    }
  );

  server.registerTool(
    'remove_reaction',
    {
      title: 'Remove Reaction',
      description: 'Remove an emoji reaction from a message.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        emoji: z.string().describe('Emoji character or shortcode'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, emoji, as }) => {
      const resolved = resolveEmoji(emoji);
      await getAgentClient(as).unreact(message_id, resolved);
      return textContent(`Removed reaction ${resolved}`);
    }
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search Messages',
      description: 'Search messages across the workspace.',
      inputSchema: {
        query: z.string().describe('Text search query'),
        channel: z.string().optional().describe('Optional channel filter'),
        from: z.string().optional().describe('Optional sender filter'),
        limit: z.number().optional().describe('Maximum results'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        results: z.array(z.object({}).passthrough()).describe('Search results'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ query, channel, from, limit, as }) =>
      jsonContent({ results: await getAgentClient(as).search(query, { channel, from, limit }) })
  );

  server.registerTool(
    'check_inbox',
    {
      title: 'Check Inbox',
      description: 'Check unread messages, mentions, DMs, and reactions for the current agent.',
      inputSchema: {
        limit: z.number().optional().describe('Maximum inbox items'),
        ...identityOverrideInputShape,
      },
      outputSchema: jsonResult,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, as }) =>
      jsonContent(await getAgentClient(as).inbox(limit != null ? { limit } : undefined))
  );

  server.registerTool(
    'mark_message_read',
    {
      title: 'Mark as Read',
      description: 'Mark a message as read for the current agent.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, as }) => {
      await getAgentClient(as).markRead(message_id);
      return textContent(`Marked message ${message_id} as read`);
    }
  );

  server.registerTool(
    'get_message_readers',
    {
      title: 'Get Readers',
      description: 'List agents who have read a message.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        readers: z.array(z.object({}).passthrough()).describe('Readers'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, as }) => jsonContent({ readers: await getAgentClient(as).readers(message_id) })
  );
}
