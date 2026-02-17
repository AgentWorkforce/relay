/**
 * Log reading utilities for the broker SDK.
 *
 * Reads agent logs from the local filesystem at
 * `.agent-relay/worker-logs/{agent}.log`.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface GetLogsOptions {
  /** Directory containing worker logs. Defaults to `.agent-relay/worker-logs` in cwd. */
  logsDir?: string;
  /** Number of lines to return from the end. Default: 50 */
  lines?: number;
}

export interface LogsResult {
  agent: string;
  content: string;
  found: boolean;
  lineCount: number;
}

function getDefaultLogsDir(): string {
  return join(process.cwd(), ".agent-relay", "worker-logs");
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  try {
    const content = await readFile(filePath, "utf-8");
    const allLines = content.split("\n");
    const tailLines = allLines.slice(-lines);
    return tailLines.join("\n").trim();
  } catch {
    return "";
  }
}

/**
 * Get logs for a specific agent.
 *
 * @example
 * ```ts
 * import { getLogs } from "agent-relay/broker";
 *
 * const result = await getLogs("Worker1", { lines: 100 });
 * if (result.found) {
 *   console.log(result.content);
 * }
 * ```
 */
export async function getLogs(
  agent: string,
  options: GetLogsOptions = {},
): Promise<LogsResult> {
  const logsDir = options.logsDir ?? getDefaultLogsDir();
  const lines = options.lines ?? 50;
  const logFile = join(logsDir, `${agent}.log`);

  // Prevent path traversal — resolved path must stay inside logsDir
  const resolvedLog = resolve(logFile);
  const resolvedDir = resolve(logsDir);
  if (!resolvedLog.startsWith(resolvedDir + sep)) {
    return { agent, content: "", found: false, lineCount: 0 };
  }

  try {
    await stat(logFile);
    const content = await tailFile(logFile, lines);
    const lineCount = content ? content.split("\n").length : 0;

    return { agent, content, found: true, lineCount };
  } catch {
    return { agent, content: "", found: false, lineCount: 0 };
  }
}

/**
 * List all agents that have log files.
 *
 * @example
 * ```ts
 * import { listLoggedAgents } from "agent-relay/broker";
 *
 * const agents = await listLoggedAgents();
 * console.log("Agents with logs:", agents);
 * ```
 */
export async function listLoggedAgents(logsDir?: string): Promise<string[]> {
  const dir = logsDir ?? getDefaultLogsDir();

  try {
    const files = await readdir(dir);
    return files
      .filter((f) => f.endsWith(".log"))
      .map((f) => f.replace(".log", ""));
  } catch {
    return [];
  }
}
