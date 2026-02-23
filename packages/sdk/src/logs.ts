/**
 * Log reading utilities for the broker SDK.
 *
 * Reads agent logs from the local filesystem at
 * `.agent-relay/worker-logs/{agent}.log`.
 */

import { open, readdir, stat } from "node:fs/promises";
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
  /** Other agents that have log files (populated when `found` is false). */
  availableAgents?: string[];
}

export type LogFollowEvent =
  | { type: "subscribed"; agent: string }
  | { type: "history"; agent: string; lines: string[] }
  | { type: "log"; agent: string; content: string }
  | { type: "error"; agent: string; error: string; availableAgents?: string[] };

export interface FollowLogsOptions {
  /** Directory containing worker logs. Defaults to `.agent-relay/worker-logs` in cwd. */
  logsDir?: string;
  /** Poll interval in ms for new log content. Default: 1000 */
  pollMs?: number;
  /** Number of history lines to emit on initial subscribe. Default: 200 */
  historyLines?: number;
  /**
   * If true, subscribe even if the log file is not present yet.
   * A `subscribed` + empty `history` event is emitted and follow continues.
   */
  allowMissing?: boolean;
  /** Event sink for subscribe/history/log/error events. */
  onEvent: (event: LogFollowEvent) => void;
}

export interface LogFollowHandle {
  unsubscribe: () => void;
}

const DEFAULT_LOG_FOLLOW_POLL_MS = 1000;
const DEFAULT_LOG_HISTORY_LINES = 200;

function getDefaultLogsDir(): string {
  return join(process.cwd(), ".agent-relay", "team", "worker-logs");
}

function splitLogLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Read the last N lines from a file by scanning backward from the end.
 *
 * Unlike the naive readFile+split approach, this only reads as much of the
 * file as needed — important for large log files that can grow to many MB.
 */
async function tailFile(filePath: string, lines: number): Promise<string> {
  const CHUNK_SIZE = 8192;
  let fh;
  try {
    fh = await open(filePath, "r");
    const { size } = await fh.stat();
    if (size === 0) return "";

    // For small files, just read the whole thing
    if (size <= CHUNK_SIZE) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      const content = buf.toString("utf-8");
      const allLines = content.split("\n");
      // Strip trailing empty element from trailing newline
      if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
        allLines.pop();
      }
      return allLines.slice(-lines).join("\n");
    }

    // For large files, read backward in chunks
    let remaining = lines;
    let position = size;
    const chunks: Buffer[] = [];
    let foundLines = 0;
    let trailingNewline = false;

    while (position > 0 && foundLines <= remaining) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, position);
      chunks.unshift(buf);

      // Count newlines in this chunk
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) {
          // Skip trailing newline at very end of file
          if (position + i === size - 1) {
            trailingNewline = true;
            continue;
          }
          foundLines++;
          if (foundLines > remaining) break;
        }
      }
    }

    const combined = Buffer.concat(chunks).toString("utf-8");
    const allLines = combined.split("\n");
    // Strip trailing empty element from trailing newline
    if (trailingNewline && allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop();
    }
    return allLines.slice(-lines).join("\n");
  } catch {
    return "";
  } finally {
    await fh?.close();
  }
}

async function readFileDelta(
  filePath: string,
  offset: number,
): Promise<{ nextOffset: number; content: string }> {
  let fh;
  try {
    fh = await open(filePath, "r");
    const { size } = await fh.stat();
    const start = size < offset ? 0 : offset;
    if (size <= start) {
      return { nextOffset: start, content: "" };
    }

    const length = size - start;
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, start);
    return { nextOffset: size, content: buffer.toString("utf-8") };
  } catch {
    return { nextOffset: offset, content: "" };
  } finally {
    await fh?.close();
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
    // Agent not found — list available agents to help the caller
    const availableAgents = await listLoggedAgents(logsDir);
    return { agent, content: "", found: false, lineCount: 0, availableAgents };
  }
}

/**
 * Follow an agent log file by polling local filesystem for appended content.
 *
 * Emits:
 * - `subscribed` once
 * - `history` once (initial tail)
 * - `log` for incremental content
 * - `error` if subscription cannot be established
 *
 * @example
 * ```ts
 * import { followLogs } from "agent-relay/broker";
 *
 * const handle = followLogs("Worker1", {
 *   historyLines: 100,
 *   onEvent(event) {
 *     if (event.type === "log") console.log(event.content);
 *   },
 * });
 *
 * setTimeout(() => handle.unsubscribe(), 30_000);
 * ```
 */
export function followLogs(agent: string, options: FollowLogsOptions): LogFollowHandle {
  const logsDir = options.logsDir ?? getDefaultLogsDir();
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_LOG_FOLLOW_POLL_MS);
  const historyLines = Math.max(0, options.historyLines ?? DEFAULT_LOG_HISTORY_LINES);
  const allowMissing = options.allowMissing ?? false;
  const logFile = join(logsDir, `${agent}.log`);

  const emit = (event: LogFollowEvent): void => {
    if (disposed) return;
    options.onEvent(event);
  };

  let disposed = false;
  let offset = 0;
  let interval: NodeJS.Timeout | undefined;
  let pollInFlight = false;

  const stop = (): void => {
    disposed = true;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  const startPolling = (): void => {
    if (disposed || interval) return;
    interval = setInterval(() => {
      void pollOnce();
    }, pollMs);
  };

  const pollOnce = async (): Promise<void> => {
    if (disposed || pollInFlight) return;
    pollInFlight = true;
    try {
      const delta = await readFileDelta(logFile, offset);
      offset = delta.nextOffset;
      if (delta.content) {
        emit({ type: "log", agent, content: delta.content });
      }
    } finally {
      pollInFlight = false;
    }
  };

  void (async () => {
    const resolvedLog = resolve(logFile);
    const resolvedDir = resolve(logsDir);
    if (!resolvedLog.startsWith(resolvedDir + sep)) {
      emit({
        type: "error",
        agent,
        error: "Invalid agent name for log path",
      });
      stop();
      return;
    }

    try {
      const history = await getLogs(agent, {
        logsDir,
        lines: historyLines,
      });

      if (!history.found && !allowMissing) {
        emit({
          type: "error",
          agent,
          error: `No local logs for '${agent}'.`,
          availableAgents: history.availableAgents,
        });
        stop();
        return;
      }

      emit({ type: "subscribed", agent });
      emit({
        type: "history",
        agent,
        lines: splitLogLines(history.content),
      });

      try {
        const logStats = await stat(logFile);
        offset = logStats.size;
      } catch {
        offset = 0;
      }

      startPolling();
    } catch {
      emit({
        type: "error",
        agent,
        error: `Failed to follow logs for '${agent}'.`,
      });
      stop();
    }
  })();

  return {
    unsubscribe: stop,
  };
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
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
}
