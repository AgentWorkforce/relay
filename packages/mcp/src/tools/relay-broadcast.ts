/**
 * relay_broadcast - Broadcast a message to all connected agents
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

export const relayBroadcastSchema = z.object({
  message: z.string().describe('The message to broadcast to all agents'),
  kind: z.enum(['message', 'action', 'state', 'thinking']).optional().describe('Message kind (default: message)'),
});

export type RelayBroadcastInput = z.infer<typeof relayBroadcastSchema>;

export const relayBroadcastTool: Tool = {
  name: 'relay_broadcast',
  description: 'Broadcast a message to ALL connected agents at once. Use this when you need to send the same message to everyone.',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to broadcast to all agents' },
      kind: { type: 'string', enum: ['message', 'action', 'state', 'thinking'], description: 'Message kind (default: message)' },
    },
    required: ['message'],
  },
};

export async function handleRelayBroadcast(client: RelayClient, input: RelayBroadcastInput): Promise<string> {
  await client.broadcast(input.message, { kind: input.kind });
  return 'Message broadcast to all agents';
}
