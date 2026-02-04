import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client-adapter.js';

export const relayStatusSchema = z.object({});

export type RelayStatusInput = z.infer<typeof relayStatusSchema>;

export const relayStatusTool: Tool = {
  name: 'relay_status',
  description: `Show connection and daemon status for Agent Relay.`,
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

/**
 * Retrieve relay daemon status and format a human-readable summary.
 */
export async function handleRelayStatus(
  client: RelayClient,
  _input: RelayStatusInput
): Promise<string> {
  const status = await client.getStatus();
  const connected = status.connected ? 'Yes' : 'No';

  let agentCount: string | number = 'unknown';
  if (typeof (client as any).listAgents === 'function') {
    try {
      const agents = await (client as any).listAgents({});
      agentCount = Array.isArray(agents) ? agents.length : 'unknown';
    } catch {
      agentCount = 'unknown';
    }
  }

  const lines = [
    `Connected: ${connected}`,
    `Agent Name: ${status.agentName}`,
    `Project: ${status.project}`,
    `Socket: ${status.socketPath}`,
  ];

  if (status.daemonVersion) {
    lines.push(`Daemon Version: ${status.daemonVersion}`);
  }

  if (status.uptime) {
    lines.push(`Uptime: ${status.uptime}`);
  }

  lines.push(`Agent Count: ${agentCount}`);

  return lines.join('\n');
}
