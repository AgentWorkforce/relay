/**
 * relay_channel_join / relay_channel_leave / relay_channel_message - Channel operations
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

// Join channel
export const relayChannelJoinSchema = z.object({
  channel: z.string().describe('The channel name to join (e.g., "#general")'),
  display_name: z.string().optional().describe('Optional display name to use in the channel'),
});

export type RelayChannelJoinInput = z.infer<typeof relayChannelJoinSchema>;

export const relayChannelJoinTool: Tool = {
  name: 'relay_channel_join',
  description: 'Join a channel to participate in group conversations. Channels start with #.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel name to join (e.g., "#general")' },
      display_name: { type: 'string', description: 'Optional display name to use in the channel' },
    },
    required: ['channel'],
  },
};

export async function handleRelayChannelJoin(client: RelayClient, input: RelayChannelJoinInput): Promise<string> {
  const result = await client.joinChannel(input.channel, input.display_name);
  if (result.success) {
    return `Joined channel "${input.channel}"`;
  }
  return `Failed to join channel: ${result.error}`;
}

// Leave channel
export const relayChannelLeaveSchema = z.object({
  channel: z.string().describe('The channel name to leave'),
  reason: z.string().optional().describe('Optional reason for leaving'),
});

export type RelayChannelLeaveInput = z.infer<typeof relayChannelLeaveSchema>;

export const relayChannelLeaveTool: Tool = {
  name: 'relay_channel_leave',
  description: 'Leave a channel you are currently in.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel name to leave' },
      reason: { type: 'string', description: 'Optional reason for leaving' },
    },
    required: ['channel'],
  },
};

export async function handleRelayChannelLeave(client: RelayClient, input: RelayChannelLeaveInput): Promise<string> {
  const result = await client.leaveChannel(input.channel, input.reason);
  if (result.success) {
    return `Left channel "${input.channel}"`;
  }
  return `Failed to leave channel: ${result.error}`;
}

// Send channel message
export const relayChannelMessageSchema = z.object({
  channel: z.string().describe('The channel to send the message to'),
  message: z.string().describe('The message content'),
  thread: z.string().optional().describe('Optional thread ID for threaded conversations'),
});

export type RelayChannelMessageInput = z.infer<typeof relayChannelMessageSchema>;

export const relayChannelMessageTool: Tool = {
  name: 'relay_channel_message',
  description: 'Send a message to a channel. You must be a member of the channel.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel to send the message to' },
      message: { type: 'string', description: 'The message content' },
      thread: { type: 'string', description: 'Optional thread ID for threaded conversations' },
    },
    required: ['channel', 'message'],
  },
};

export async function handleRelayChannelMessage(client: RelayClient, input: RelayChannelMessageInput): Promise<string> {
  await client.sendChannelMessage(input.channel, input.message, { thread: input.thread });
  return `Message sent to channel "${input.channel}"`;
}

// Admin join channel
export const relayAdminChannelJoinSchema = z.object({
  channel: z.string().describe('The channel name'),
  member: z.string().describe('The agent name to add to the channel'),
});

export type RelayAdminChannelJoinInput = z.infer<typeof relayAdminChannelJoinSchema>;

export const relayAdminChannelJoinTool: Tool = {
  name: 'relay_admin_channel_join',
  description: 'Admin operation: Add any agent to a channel (does not require the agent to be connected).',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel name' },
      member: { type: 'string', description: 'The agent name to add to the channel' },
    },
    required: ['channel', 'member'],
  },
};

export async function handleRelayAdminChannelJoin(client: RelayClient, input: RelayAdminChannelJoinInput): Promise<string> {
  const result = await client.adminJoinChannel(input.channel, input.member);
  if (result.success) {
    return `Added "${input.member}" to channel "${input.channel}"`;
  }
  return `Failed to add member: ${result.error}`;
}

// Admin remove member
export const relayAdminRemoveMemberSchema = z.object({
  channel: z.string().describe('The channel name'),
  member: z.string().describe('The agent name to remove from the channel'),
});

export type RelayAdminRemoveMemberInput = z.infer<typeof relayAdminRemoveMemberSchema>;

export const relayAdminRemoveMemberTool: Tool = {
  name: 'relay_admin_remove_member',
  description: 'Admin operation: Remove any agent from a channel.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'The channel name' },
      member: { type: 'string', description: 'The agent name to remove from the channel' },
    },
    required: ['channel', 'member'],
  },
};

export async function handleRelayAdminRemoveMember(client: RelayClient, input: RelayAdminRemoveMemberInput): Promise<string> {
  const result = await client.adminRemoveMember(input.channel, input.member);
  if (result.success) {
    return `Removed "${input.member}" from channel "${input.channel}"`;
  }
  return `Failed to remove member: ${result.error}`;
}
