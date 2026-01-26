import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RelayClient } from '../client.js';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { getProjectPaths } from '@agent-relay/config';

const execAsync = promisify(exec);

export const relayLogsSchema = z.object({
  agent: z.string().describe('Name of the agent to get logs for'),
  lines: z.number().optional().default(50).describe('Number of lines to retrieve (default: 50)'),
});

export type RelayLogsInput = z.infer<typeof relayLogsSchema>;

export const relayLogsTool: Tool = {
  name: 'relay_logs',
  description: `Read recent output logs from another agent.

Use this to:
- Monitor worker progress on tasks
- Debug issues with spawned agents
- Check what an agent has been outputting

Returns the last N lines of the agent's output log.

Example: Get last 100 lines from Worker1
  { "agent": "Worker1", "lines": 100 }`,
  inputSchema: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Name of the agent to get logs for',
      },
      lines: {
        type: 'number',
        description: 'Number of lines to retrieve (default: 50)',
        default: 50,
      },
    },
    required: ['agent'],
  },
};

/**
 * Get the worker logs directory path.
 * Uses getProjectPaths from @agent-relay/config to match the bridge package.
 */
function getWorkerLogsDir(projectRoot: string): string {
  const paths = getProjectPaths(projectRoot);
  return path.join(paths.teamDir, 'worker-logs');
}

/**
 * Read recent logs from an agent's output file.
 */
export async function handleRelayLogs(
  client: RelayClient,
  input: RelayLogsInput
): Promise<string> {
  const { agent, lines = 50 } = input;

  // Get project root from client status
  const status = await client.getStatus();
  const projectRoot = status.project || process.cwd();

  const logsDir = getWorkerLogsDir(projectRoot);
  const logFile = path.join(logsDir, `${agent}.log`);

  if (!fs.existsSync(logFile)) {
    // Try to list available log files
    let availableAgents: string[] = [];
    try {
      if (fs.existsSync(logsDir)) {
        availableAgents = fs.readdirSync(logsDir)
          .filter(f => f.endsWith('.log'))
          .map(f => f.replace('.log', ''));
      }
    } catch {
      // Ignore errors listing directory
    }

    if (availableAgents.length > 0) {
      return `No logs found for agent "${agent}".\n\nAvailable agents with logs:\n${availableAgents.map(a => `- ${a}`).join('\n')}`;
    }
    return `No logs found for agent "${agent}". The agent may not have been spawned yet or has no output.`;
  }

  try {
    const { stdout } = await execAsync(`tail -n ${lines} "${logFile}"`);
    const logContent = stdout.trim();

    if (!logContent) {
      return `Logs for ${agent} (last ${lines} lines):\n(empty - no output yet)`;
    }

    return `Logs for ${agent} (last ${lines} lines):\n${'─'.repeat(50)}\n${logContent}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to read logs for "${agent}": ${message}`;
  }
}
