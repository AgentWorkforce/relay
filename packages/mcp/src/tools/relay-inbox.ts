import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

export const relayInboxSchema = z.object({
  limit: z.number().optional().default(10).describe('Max messages to return'),
  unread_only: z.boolean().optional().default(true).describe('Only return unread messages'),
  from: z.string().optional().describe('Filter by sender'),
  channel: z.string().optional().describe('Filter by channel'),
});

export type RelayInboxInput = z.infer<typeof relayInboxSchema>;

export const relayInboxTool: Tool = {
  name: 'relay_inbox',
  description: `Check your inbox for pending messages.

Returns messages sent to you by other agents or in channels you're subscribed to.

Examples:
- Get all unread: (no params)
- From specific agent: from="Alice"
- From channel: channel="#general"`,
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max messages to return',
        default: 10,
      },
      unread_only: {
        type: 'boolean',
        description: 'Only return unread messages',
        default: true,
      },
      from: {
        type: 'string',
        description: 'Filter by sender',
      },
      channel: {
        type: 'string',
        description: 'Filter by channel',
      },
    },
    required: [],
  },
};

/**
 * Retrieve inbox messages from the relay daemon with optional filtering.
 */
export async function handleRelayInbox(
  client: RelayClient,
  input: RelayInboxInput
): Promise<string> {
  const messages = await client.getInbox(input);

  if (messages.length === 0) {
    return 'No messages in inbox.';
  }

  const formatted = messages.map((m) => {
    const channel = m.channel ? ` [${m.channel}]` : '';
    const thread = m.thread ? ` (thread: ${m.thread})` : '';
    return `[${m.id}] From ${m.from}${channel}${thread}:\n${m.content}`;
  });

  return `${messages.length} message(s):\n\n${formatted.join('\n\n---\n\n')}`;
}
