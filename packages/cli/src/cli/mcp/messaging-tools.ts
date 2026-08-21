import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { replayMessageMetadata } from '@agent-relay/sdk';
import { z } from 'zod';

import {
  compactDirectMessageReceipt,
  directMessageDeliveryFailure,
  directMessageReceipt,
  messageReadersReceipt,
  resolveExactAgentName,
} from '../lib/message-delivery-receipts.js';
import { jsonContent, jsonResult, textContent } from './tool-results.js';
import { identityOverrideInputShape, messageResult } from './tool-shapes.js';
import type { AgentClientLike } from './types.js';

const directMessageResult = z.looseObject({
  id: z.string().optional().describe('Message ID, for "get_message_readers"'),
  conversationId: z.string().optional().describe('DM conversation ID, addressing relay://dm/{id}'),
  target: z.object({ kind: z.literal('agent'), agentName: z.string() }).optional(),
  delivery: z.object({
    status: z.enum(['queued_unconfirmed', 'recipient_mismatch', 'recipient_unresolved']),
    mode: z.enum(['wait', 'steer']),
    requestedRecipient: z.string(),
    resolvedRecipient: z.string().nullable(),
    recipientMatched: z.boolean().nullable(),
    readConfirmed: z.literal(false),
    note: z.string(),
  }),
});

const messageReadersResult = {
  readers: z.array(z.looseObject({})).describe('Readers'),
  delivery: z.object({
    status: z.enum(['read', 'queued_or_unread']),
    readConfirmed: z.boolean(),
    signal: z.string(),
  }),
};

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
  getAgentClient: (asIdentity?: string) => AgentClientLike,
  listAgentsForRecipientResolution?: () => Promise<unknown[] | undefined>
): void {
  server.registerTool(
    'create_channel',
    {
      title: 'Create Channel',
      description:
        'Create a new workspace channel. ' +
        'Returns the created channel record, including the name other agents use to join or post to it.',
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
      description:
        'List channels available in the workspace. ' +
        'Returns a `channels` array. Archived channels are excluded unless `include_archived` is set.',
      inputSchema: {
        include_archived: z.boolean().optional().describe('Include archived channels'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        channels: z.array(z.looseObject({})).describe('Channels'),
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
      description:
        'Join an existing channel so its messages reach this agent. ' +
        'Returns a confirmation message naming the channel joined.',
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
      description:
        "Stop receiving a channel's messages without archiving it for anyone else. " +
        'Returns a confirmation message naming the channel left.',
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
      description:
        'Invite another agent to a channel. ' +
        'Returns a confirmation message naming the invited agent and the channel.',
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
      description:
        "Replace a channel's topic with new text. " +
        'Returns the updated channel record carrying the new topic.',
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
      description:
        'Archive a channel for the whole workspace, closing it to new messages. ' +
        'Returns a confirmation message naming the archived channel. Archived channels stay readable and are surfaced by "list_channels" only when `include_archived` is set.',
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
      description:
        'Post a new message to a channel as the current agent. ' +
        'Returns the created message record, including the message ID needed to reply to it with "reply_to_thread" or react to it with "add_reaction".',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        text: z.string().describe('Message text'),
        attachments: z.array(z.string()).optional().describe('File attachment IDs'),
        mode: z
          .enum(['wait', 'steer'])
          .optional()
          .describe(
            'wait (default): queue delivery until each recipient reaches a safe idle boundary; steer: request immediate injection, which may interrupt active work.'
          ),
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
      jsonContent(
        await getAgentClient(as).send(channel, text, {
          attachments,
          data: replayMessageMetadata(),
          mode,
        })
      )
  );

  server.registerTool(
    'list_messages',
    {
      title: 'Get Messages',
      description:
        'Retrieve message history from a channel. ' +
        'Returns a `messages` array. Pass a message ID from a previous call as `before` or `after` to page through history beyond a single `limit`.',
      inputSchema: {
        channel: z.string().describe('Channel name'),
        limit: z.number().optional().describe('Maximum messages to return'),
        before: z.string().optional().describe('Older-than cursor'),
        after: z.string().optional().describe('Newer-than cursor'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        messages: z.array(z.looseObject({})).describe('Messages'),
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
      description:
        'Post a threaded reply under an existing message instead of to the channel at large. ' +
        'Returns the created reply record with its own message ID.',
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
    async ({ message_id, text, as }) =>
      jsonContent(await getAgentClient(as).reply(message_id, text, { data: replayMessageMetadata() }))
  );

  server.registerTool(
    'get_message_thread',
    {
      title: 'Get Thread',
      description:
        'Retrieve a message thread. ' +
        'Returns the parent message together with its replies, capped by `limit` when a positive value is supplied. A `limit` of 0 is ignored and returns the full thread.',
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
      description:
        'Send a private direct message visible only to the recipient and this agent. ' +
        'Returns a compact delivery receipt — the message ID, the conversation ID, and an explicit queued/unconfirmed delivery status. ' +
        'The receipt deliberately does not echo the message body back; you already have the text you sent. ' +
        'Returns a tool error while preserving that receipt when the recipient cannot be resolved exactly. ' +
        'A message ID confirms enqueue, not injection or reading; use "get_message_readers" to confirm consumption. ' +
        'Mode "wait" (the default) waits for the recipient\'s next safe idle boundary and can remain unread while they are busy. ' +
        'Mode "steer" requests immediate injection and may interrupt active work.',
      inputSchema: {
        to: z.string().describe('Recipient agent name'),
        text: z.string().describe('DM text'),
        mode: z
          .enum(['wait', 'steer'])
          .optional()
          .describe(
            'wait (default): queue until the recipient reaches a safe idle boundary; steer: request immediate injection, which may interrupt active work. Both modes return before reading is confirmed.'
          ),
        attachments: z.array(z.string()).optional().describe('File attachment IDs'),
        ...identityOverrideInputShape,
      },
      outputSchema: directMessageResult,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ to, text, mode, attachments, as }) => {
      const agents = await listAgentsForRecipientResolution?.();
      const resolvedRecipient = agents ? resolveExactAgentName(agents, to) : undefined;
      const message = await getAgentClient(as).dm(to, text, {
        mode,
        attachments,
        data: replayMessageMetadata(),
      });
      const receipt = compactDirectMessageReceipt(
        directMessageReceipt(message, to, mode, resolvedRecipient)
      );
      const result = jsonContent(receipt);
      return directMessageDeliveryFailure(receipt) ? { ...result, isError: true as const } : result;
    }
  );

  server.registerTool(
    'list_dms',
    {
      title: 'List DM Conversations',
      description:
        'List direct message conversations for the current agent. ' +
        'Returns a `conversations` array covering both one-to-one and group DMs. Each conversation ID addresses the `relay://dm/{conversation_id}` resource, which holds that conversation\'s messages; no tool sends a follow-up message by conversation ID, so reply with "send_dm" to the recipient by name.',
      inputSchema: {
        ...identityOverrideInputShape,
      },
      outputSchema: {
        conversations: z.array(z.looseObject({})).describe('DM conversations'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ as }) => jsonContent({ conversations: await getAgentClient(as).dms.conversations() })
  );

  server.registerTool(
    'send_group_dm',
    {
      title: 'Send Group DM',
      description:
        'Open a private group conversation with several agents and post its first message. ' +
        'Returns the created `conversation` and the `message` posted to it.',
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
      const message = await client.dms.sendMessage(conversation.id, text, {
        data: replayMessageMetadata(),
      });
      return jsonContent({ conversation, message });
    }
  );

  server.registerTool(
    'add_reaction',
    {
      title: 'Add Reaction',
      description:
        'Add an emoji reaction to a message. ' +
        'Accepts a raw emoji or a shortcode such as `:+1:` or `rocket`. Returns a confirmation message showing the emoji the shortcode resolved to.',
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
      description:
        "Remove one of this agent's emoji reactions from a message. " +
        'Accepts the same raw emoji or shortcode forms as "add_reaction". Returns a confirmation message showing the resolved emoji.',
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
      description:
        'Search messages across every channel this agent can see. ' +
        'Returns a `results` array of matching messages, narrowed by the optional `channel` and `from` filters. An empty array means nothing matched.',
      inputSchema: {
        query: z.string().describe('Text search query'),
        channel: z.string().optional().describe('Optional channel filter'),
        from: z.string().optional().describe('Optional sender filter'),
        limit: z.number().optional().describe('Maximum results'),
        ...identityOverrideInputShape,
      },
      outputSchema: {
        results: z.array(z.looseObject({})).describe('Search results'),
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
      description:
        'Check unread messages, mentions, DMs, and reactions for the current agent. ' +
        'Returns the inbox payload grouping unread items by kind. Reading the inbox does not clear it — call "mark_message_read" to do that.',
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
      description:
        "Clear a message from this agent's unread inbox. " +
        'Returns a confirmation message naming the message ID marked read.',
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
      description:
        'Check which agents have read a message, to confirm delivery before acting on silence. ' +
        'Returns a `readers` array plus an explicit delivery signal. An empty array is reported as queued-or-unread: nobody has consumed the message yet, even if the recipient is live.',
      inputSchema: {
        message_id: z.string().describe('Message ID'),
        ...identityOverrideInputShape,
      },
      outputSchema: messageReadersResult,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ message_id, as }) =>
      jsonContent(messageReadersReceipt(await getAgentClient(as).readers(message_id)))
  );
}
