/**
 * relay_query_messages - Query message history
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

export const relayQueryMessagesSchema = z.object({
  limit: z.number().optional().describe('Maximum number of messages to return (default: 100)'),
  since_ts: z.number().optional().describe('Only return messages after this Unix timestamp (ms)'),
  from: z.string().optional().describe('Filter by sender name'),
  to: z.string().optional().describe('Filter by recipient name'),
  thread: z.string().optional().describe('Filter by thread ID'),
  order: z.enum(['asc', 'desc']).optional().describe('Sort order (default: desc)'),
});

export type RelayQueryMessagesInput = z.infer<typeof relayQueryMessagesSchema>;

export const relayQueryMessagesTool: Tool = {
  name: 'relay_query_messages',
  description: 'Query message history. Returns all messages matching the filters, useful for viewing conversation history or debugging.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of messages to return (default: 100)' },
      since_ts: { type: 'number', description: 'Only return messages after this Unix timestamp (ms)' },
      from: { type: 'string', description: 'Filter by sender name' },
      to: { type: 'string', description: 'Filter by recipient name' },
      thread: { type: 'string', description: 'Filter by thread ID' },
      order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order (default: desc)' },
    },
    required: [],
  },
};

export async function handleRelayQueryMessages(client: RelayClient, input: RelayQueryMessagesInput): Promise<string> {
  const messages = await client.queryMessages({
    limit: input.limit,
    sinceTs: input.since_ts,
    from: input.from,
    to: input.to,
    thread: input.thread,
    order: input.order,
  });

  if (messages.length === 0) {
    return 'No messages found matching the filters.';
  }

  const formatted = messages.map(m => {
    const timestamp = new Date(m.timestamp).toISOString();
    const meta: string[] = [];
    if (m.thread) meta.push(`thread:${m.thread}`);
    if (m.channel) meta.push(`channel:${m.channel}`);
    if (m.status) meta.push(`status:${m.status}`);
    if (m.isBroadcast) meta.push('broadcast');
    if (typeof m.replyCount === 'number') meta.push(`replies:${m.replyCount}`);
    if (m.data && Object.keys(m.data).length > 0) meta.push('data');

    const metaStr = meta.length ? ` [${meta.join(', ')}]` : '';
    return `[${timestamp}] ${m.from} -> ${m.to}${metaStr}: ${m.body}`;
  }).join('\n');

  return `Found ${messages.length} message(s):\n${formatted}`;
}
