/**
 * Log reading utilities for Agent Relay SDK.
 *
 * These utilities read agent logs from the local filesystem.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Options for reading agent logs.
 */
export interface GetLogsOptions {
  /** Directory containing worker logs. Defaults to `.agent-relay/worker-logs` in cwd. */
  logsDir?: string;
  /** Number of lines to return from the end. Default: 50 */
  lines?: number;
}

/**
 * Result of a logs query.
 */
export interface LogsResult {
  /** Agent name */
  agent: string;
  /** Log content */
  content: string;
  /** Whether log file exists */
  found: boolean;
  /** Number of lines returned */
  lineCount: number;
}

/**
 * Get the default logs directory path.
 */
function getDefaultLogsDir(): string {
  return join(process.cwd(), '.agent-relay', 'worker-logs');
}

/**
 * Read the last N lines from a file.
 */
async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const allLines = content.split('\n');
    const tailLines = allLines.slice(-lines);
    return tailLines.join('\n').trim();
  } catch {
    return '';
  }
}

/**
 * Get logs for a specific agent.
 *
 * @example
 * ```typescript
 * import { getLogs } from '@agent-relay/sdk';
 *
 * const result = await getLogs('Worker1', { lines: 100 });
 * if (result.found) {
 *   console.log(result.content);
 * }
 * ```
 *
 * @param agent - Agent name
 * @param options - Options for reading logs
 * @returns Log content and metadata
 */
export async function getLogs(
  agent: string,
  options: GetLogsOptions = {}
): Promise<LogsResult> {
  const logsDir = options.logsDir ?? getDefaultLogsDir();
  const lines = options.lines ?? 50;
  const logFile = join(logsDir, `${agent}.log`);

  try {
    await stat(logFile);
    const content = await tailFile(logFile, lines);
    const lineCount = content ? content.split('\n').length : 0;

    return {
      agent,
      content,
      found: true,
      lineCount,
    };
  } catch {
    return {
      agent,
      content: '',
      found: false,
      lineCount: 0,
    };
  }
}

/**
 * List all agents that have log files.
 *
 * @example
 * ```typescript
 * import { listLoggedAgents } from '@agent-relay/sdk';
 *
 * const agents = await listLoggedAgents();
 * console.log('Agents with logs:', agents);
 * ```
 *
 * @param logsDir - Directory containing worker logs
 * @returns Array of agent names
 */
export async function listLoggedAgents(logsDir?: string): Promise<string[]> {
  const dir = logsDir ?? getDefaultLogsDir();

  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith('.log'))
      .map((f) => f.replace('.log', ''));
  } catch {
    return [];
  }
}
