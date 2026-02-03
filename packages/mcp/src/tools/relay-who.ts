import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';

export const relayWhoSchema = z.object({
  include_idle: z.boolean().optional().default(true).describe('Include idle agents'),
  project: z.string().optional().describe('Filter by project (for multi-project setups)'),
});

export type RelayWhoInput = z.infer<typeof relayWhoSchema>;

export const relayWhoTool: Tool = {
  name: 'relay_who',
  description: `List online agents in the relay network.

Shows agent names, their CLI type, and current status.

Example output:
- Alice (claude) - active
- Bob (codex) - idle
- TestRunner (claude) - active [worker of: Alice]`,
  inputSchema: {
    type: 'object',
    properties: {
      include_idle: {
        type: 'boolean',
        description: 'Include idle agents',
        default: true,
      },
      project: {
        type: 'string',
        description: 'Filter by project',
      },
    },
    required: [],
  },
};

/**
 * List online agents with status and optional project filtering.
 */
export async function handleRelayWho(
  client: RelayClient,
  input: RelayWhoInput
): Promise<string> {
  let agents: Awaited<ReturnType<typeof client.listAgents>>;

  try {
    agents = await client.listAgents(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to list agents: ${message}`;
  }

  // Defensive check: ensure agents is an array
  if (!agents || !Array.isArray(agents)) {
    // Log for debugging if DEBUG env is set
    if (process.env.DEBUG || process.env.RELAY_DEBUG) {
      console.error('[relay_who] listAgents returned non-array:', typeof agents, agents);
    }
    return 'Failed to list agents: unexpected response format';
  }

  if (agents.length === 0) {
    return 'No agents online.';
  }

  const formatted = agents.map((a) => {
    const status = a.idle ? 'idle' : 'active';
    const worker = a.parent ? ` [worker of: ${a.parent}]` : '';
    return `- ${a.name} (${a.cli ?? 'unknown'}) - ${status}${worker}`;
  });

  return `${agents.length} agent(s) online:\n${formatted.join('\n')}`;
}
