import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient, MetricsResponse } from '../client.js';

export const relayMetricsSchema = z.object({
  agent: z.string().optional().describe('Filter metrics to a specific agent'),
});

export type RelayMetricsInput = z.infer<typeof relayMetricsSchema>;

export const relayMetricsTool: Tool = {
  name: 'relay_metrics',
  description: `Get memory and resource metrics for agents.

Use this to:
- Monitor memory usage across agents
- Detect resource-heavy workers
- Identify memory leaks or runaway processes
- Make informed decisions about spawning new workers

Returns CPU/memory usage per agent plus system totals.

Example: Get all agent metrics
  {}

Example: Get metrics for specific agent
  { "agent": "Worker1" }`,
  inputSchema: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Filter metrics to a specific agent',
      },
    },
    required: [],
  },
};

/**
 * Format bytes to human readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Format uptime in milliseconds to human readable string.
 */
function formatUptime(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/**
 * Get memory and resource metrics for agents.
 */
export async function handleRelayMetrics(
  client: RelayClient,
  input: RelayMetricsInput
): Promise<string> {
  try {
    const data: MetricsResponse = await client.getMetrics({ agent: input.agent });
    let agents = data.agents;

    // Filter to specific agent if requested
    if (input.agent) {
      agents = agents.filter(a => a.name === input.agent);
      if (agents.length === 0) {
        const available = data.agents.map(a => a.name).join(', ');
        return `Agent "${input.agent}" not found.\n\nAvailable agents: ${available || 'none'}`;
      }
    }

    if (agents.length === 0) {
      return 'No agents with metrics data.';
    }

    // Build output
    const lines: string[] = [];
    lines.push('AGENT METRICS');
    lines.push('═'.repeat(60));
    lines.push('');

    // System summary
    lines.push(`System: ${formatBytes(data.system.heapUsed)} heap used / ${formatBytes(data.system.freeMemory)} free`);
    lines.push('');

    // Per-agent metrics
    lines.push('NAME                 MEMORY      CPU     UPTIME    STATUS');
    lines.push('─'.repeat(60));

    for (const agent of agents) {
      const name = agent.name.padEnd(20).substring(0, 20);
      const memory = agent.rssBytes ? formatBytes(agent.rssBytes).padEnd(10) : 'N/A'.padEnd(10);
      const cpu = agent.cpuPercent !== undefined ? `${agent.cpuPercent.toFixed(1)}%`.padEnd(7) : 'N/A'.padEnd(7);
      const uptime = agent.uptimeMs ? formatUptime(agent.uptimeMs).padEnd(9) : 'N/A'.padEnd(9);
      const status = agent.status;

      let statusIndicator = '';
      if (agent.alertLevel === 'critical') {
        statusIndicator = ' [CRITICAL]';
      } else if (agent.alertLevel === 'warning') {
        statusIndicator = ' [WARNING]';
      } else if (agent.trend === 'rising') {
        statusIndicator = ' [↑]';
      }

      lines.push(`${name} ${memory} ${cpu} ${uptime} ${status}${statusIndicator}`);
    }

    // Add recommendations for high resource usage
    const criticalAgents = agents.filter(a => a.alertLevel === 'critical');
    const warningAgents = agents.filter(a => a.alertLevel === 'warning');

    if (criticalAgents.length > 0 || warningAgents.length > 0) {
      lines.push('');
      lines.push('ALERTS:');
      for (const agent of criticalAgents) {
        lines.push(`  🔴 ${agent.name}: Critical memory usage (${formatBytes(agent.rssBytes || 0)})`);
      }
      for (const agent of warningAgents) {
        lines.push(`  🟡 ${agent.name}: High memory usage (${formatBytes(agent.rssBytes || 0)})`);
      }
    }

    return lines.join('\n');
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
      return `Cannot connect to daemon. Is the daemon running?\n\nRun 'agent-relay up' to start the daemon.`;
    }
    return `Failed to fetch metrics: ${error.message || String(err)}`;
  }
}
