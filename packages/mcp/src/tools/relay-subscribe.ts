/**
 * relay_subscribe / relay_unsubscribe - Pub/Sub topic subscription
 */

import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

// Subscribe schema and tool
export const relaySubscribeSchema = z.object({
  topic: z.string().describe('The topic to subscribe to'),
});

export type RelaySubscribeInput = z.infer<typeof relaySubscribeSchema>;

export const relaySubscribeTool: Tool = {
  name: 'relay_subscribe',
  description: 'Subscribe to a topic to receive messages published to that topic.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The topic to subscribe to' },
    },
    required: ['topic'],
  },
};

export async function handleRelaySubscribe(client: RelayClient, input: RelaySubscribeInput): Promise<string> {
  const result = await client.subscribe(input.topic);
  if (result.success) {
    return `Subscribed to topic "${input.topic}"`;
  }
  return `Failed to subscribe: ${result.error}`;
}

// Unsubscribe schema and tool
export const relayUnsubscribeSchema = z.object({
  topic: z.string().describe('The topic to unsubscribe from'),
});

export type RelayUnsubscribeInput = z.infer<typeof relayUnsubscribeSchema>;

export const relayUnsubscribeTool: Tool = {
  name: 'relay_unsubscribe',
  description: 'Unsubscribe from a topic to stop receiving messages from it.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The topic to unsubscribe from' },
    },
    required: ['topic'],
  },
};

export async function handleRelayUnsubscribe(client: RelayClient, input: RelayUnsubscribeInput): Promise<string> {
  const result = await client.unsubscribe(input.topic);
  if (result.success) {
    return `Unsubscribed from topic "${input.topic}"`;
  }
  return `Failed to unsubscribe: ${result.error}`;
}
