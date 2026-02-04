import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient, HealthResponse } from '../client-adapter.js';

export const relayHealthSchema = z.object({
  include_crashes: z.boolean().optional().default(true).describe('Include recent crash history'),
  include_alerts: z.boolean().optional().default(true).describe('Include unacknowledged alerts'),
});

export type RelayHealthInput = z.infer<typeof relayHealthSchema>;

export const relayHealthTool: Tool = {
  name: 'relay_health',
  description: `Get system health, crash insights, and recommendations.

Use this to:
- Check overall system health score
- View recent agent crashes and their causes
- Get recommendations for improving stability
- Identify recurring issues

Returns health score (0-100), issues, recommendations, and crash history.

Example: Full health check
  {}

Example: Health check without crash history
  { "include_crashes": false }`,
  inputSchema: {
    type: 'object',
    properties: {
      include_crashes: {
        type: 'boolean',
        description: 'Include recent crash history',
        default: true,
      },
      include_alerts: {
        type: 'boolean',
        description: 'Include unacknowledged alerts',
        default: true,
      },
    },
    required: [],
  },
};

/**
 * Get system health, crash insights, and recommendations.
 */
export async function handleRelayHealth(
  client: RelayClient,
  input: RelayHealthInput
): Promise<string> {
  try {
    const data: HealthResponse = await client.getHealth({
      include_crashes: input.include_crashes,
      include_alerts: input.include_alerts,
    });

    const lines: string[] = [];

    // Health score header
    const scoreEmoji = data.healthScore >= 80 ? '✅' :
                       data.healthScore >= 50 ? '⚠️' : '🔴';

    lines.push('═'.repeat(60));
    lines.push(`  SYSTEM HEALTH: ${scoreEmoji} ${data.healthScore}/100`);
    lines.push('═'.repeat(60));
    lines.push('');
    lines.push(`  ${data.summary}`);
    lines.push('');

    // Stats
    lines.push(`  Agents: ${data.stats.agentCount}`);
    lines.push(`  Crashes (24h): ${data.stats.totalCrashes24h}`);
    lines.push(`  Alerts (24h): ${data.stats.totalAlerts24h}`);
    lines.push('');

    // Issues
    if (data.issues.length > 0) {
      lines.push('ISSUES:');
      for (const issue of data.issues) {
        const icon = issue.severity === 'critical' ? '🔴' :
                     issue.severity === 'high' ? '🟠' :
                     issue.severity === 'medium' ? '🟡' : '🔵';
        lines.push(`  ${icon} ${issue.message}`);
      }
      lines.push('');
    }

    // Recommendations
    if (data.recommendations.length > 0) {
      lines.push('RECOMMENDATIONS:');
      for (const rec of data.recommendations) {
        lines.push(`  → ${rec}`);
      }
      lines.push('');
    }

    // Crashes
    if (input.include_crashes && data.crashes.length > 0) {
      lines.push('RECENT CRASHES:');
      lines.push('─'.repeat(60));
      for (const crash of data.crashes.slice(0, 5)) {
        const time = new Date(crash.crashedAt).toLocaleString();
        lines.push(`  ${crash.agentName} - ${time}`);
        lines.push(`    Cause: ${crash.likelyCause}`);
        if (crash.summary) {
          lines.push(`    Summary: ${crash.summary.substring(0, 80)}${crash.summary.length > 80 ? '...' : ''}`);
        }
        lines.push('');
      }
      if (data.crashes.length > 5) {
        lines.push(`  ... and ${data.crashes.length - 5} more crashes`);
        lines.push('');
      }
    }

    // Alerts
    if (input.include_alerts && data.alerts.length > 0) {
      lines.push('UNACKNOWLEDGED ALERTS:');
      lines.push('─'.repeat(60));
      for (const alert of data.alerts.slice(0, 5)) {
        const time = new Date(alert.createdAt).toLocaleString();
        lines.push(`  [${alert.alertType}] ${alert.agentName} - ${time}`);
        lines.push(`    ${alert.message}`);
        lines.push('');
      }
      if (data.alerts.length > 5) {
        lines.push(`  ... and ${data.alerts.length - 5} more alerts`);
        lines.push('');
      }
    }

    // No issues message
    if (data.issues.length === 0 && data.crashes.length === 0 && data.alerts.length === 0) {
      lines.push('No issues detected. System is healthy.');
    }

    return lines.join('\n');
  } catch (err: unknown) {
    const error = err as Error & { code?: string };
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
      return `Cannot connect to daemon. Is the daemon running?\n\nRun 'agent-relay up' to start the daemon.`;
    }
    return `Failed to fetch health data: ${error.message || String(err)}`;
  }
}
