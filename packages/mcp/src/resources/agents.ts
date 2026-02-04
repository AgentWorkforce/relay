/**
 * Agents Resource
 *
 * Provides live list of online agents as an MCP resource.
 * URI: relay://agents
 */

import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

export const agentsResource: Resource = {
  uri: 'relay://agents',
  name: 'Online Agents',
  description: 'Live list of agents currently connected to relay',
  mimeType: 'application/json',
};

export async function getAgentsResource(client: RelayClient): Promise<string> {
  const agents = await client.listAgents({ include_idle: true });
  return JSON.stringify(agents, null, 2);
}
