import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';

export const relayRemoveAgentSchema = z.object({
  name: z.string().describe('Name of the agent to remove from the registry'),
  remove_messages: z.boolean().optional().default(false).describe('Also remove all messages from/to this agent'),
});

export type RelayRemoveAgentInput = z.infer<typeof relayRemoveAgentSchema>;

export const relayRemoveAgentTool: Tool = {
  name: 'relay_remove_agent',
  description: `Remove a stale agent from the relay registry.

Use this to clean up agents that are no longer needed or have become stale.
This removes the agent from:
- The agent registry (agents.json)
- The sessions table in storage
- Optionally, all messages from/to this agent

WARNING: This permanently removes the agent's history. Use with caution.`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the agent to remove',
      },
      remove_messages: {
        type: 'boolean',
        description: 'Also remove all messages from/to this agent',
        default: false,
      },
    },
    required: ['name'],
  },
};

/**
 * Remove an agent from the registry.
 */
export async function handleRelayRemoveAgent(
  client: RelayClient,
  input: RelayRemoveAgentInput
): Promise<string> {
  const result = await client.removeAgent(input.name, {
    removeMessages: input.remove_messages,
  });

  if (result.success && result.removed) {
    return `✓ ${result.message}`;
  } else if (result.success && !result.removed) {
    return `Agent "${input.name}" was not found in registry or storage.`;
  } else {
    return `✗ Failed to remove agent: ${result.message}`;
  }
}
