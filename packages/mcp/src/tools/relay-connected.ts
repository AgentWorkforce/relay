import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';

export const relayConnectedSchema = z.object({
  project: z.string().optional().describe('Filter by project (for multi-project setups)'),
});

export type RelayConnectedInput = z.infer<typeof relayConnectedSchema>;

export const relayConnectedTool: Tool = {
  name: 'relay_connected',
  description: `List only currently connected agents in the relay network.

Unlike relay_who which includes historical/registered agents, this only shows
agents that are actively connected right now. Use this for accurate liveness checks.

Example output:
- Alice (claude) - connected
- Bob (codex) - connected`,
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description: 'Filter by project',
      },
    },
    required: [],
  },
};

/**
 * List only currently connected agents (not historical/registered).
 */
export async function handleRelayConnected(
  client: RelayClient,
  input: RelayConnectedInput
): Promise<string> {
  let agents: Awaited<ReturnType<typeof client.listConnectedAgents>>;

  try {
    agents = await client.listConnectedAgents(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to list connected agents: ${message}`;
  }

  // Defensive check: ensure agents is an array
  if (!agents || !Array.isArray(agents)) {
    if (process.env.DEBUG || process.env.RELAY_DEBUG) {
      console.error('[relay_connected] listConnectedAgents returned non-array:', typeof agents, agents);
    }
    return 'Failed to list connected agents: unexpected response format';
  }

  if (agents.length === 0) {
    return 'No agents currently connected.';
  }

  const formatted = agents.map((a: { name: string; cli?: string; parent?: string }) => {
    const worker = a.parent ? ` [worker of: ${a.parent}]` : '';
    return `- ${a.name} (${a.cli || 'unknown'}) - connected${worker}`;
  });

  return `${agents.length} agent(s) currently connected:\n${formatted.join('\n')}`;
}
