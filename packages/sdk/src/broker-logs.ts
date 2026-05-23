/**
 * Helpers for the broker's tracing log directory.
 *
 * The Rust broker writes its diagnostic logs to a platform-standard directory
 * with daily rotation (see `crates/broker/src/runtime/util.rs::broker_log_dir`).
 * This module mirrors that path so the TypeScript CLI can list, tail, prune,
 * and clear those files without spawning the broker.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readdir, stat, unlink, open, type FileHandle } from 'node:fs/promises';

export interface BrokerLogFile {
  /** Absolute path to the log file. */
  path: string;
  /** Just the file name, e.g. `myproject.log.2026-05-21`. */
  name: string;
  /** Broker identifier inferred from the filename (the prefix before `.log`). */
  brokerId: string;
  /**
   * The rotation date suffix in `YYYY-MM-DD` form, or `null` for the
   * pre-rotation file laid down before `tracing-appender` rolled over.
   */
  date: string | null;
  /** File size in bytes. */
  size: number;
  /** Last-modified time. */
  mtime: Date;
}

const LOG_NAME_PATTERN = /^(?<brokerId>.+)\.log(?:\.(?<date>\d{4}-\d{2}-\d{2}))?$/;

/**
 * Resolve the platform-standard broker log directory. Matches the Rust
 * implementation in `runtime/util.rs::broker_log_dir`.
 *
 * - macOS: `~/Library/Logs/agent-relay`
 * - Linux / other Unix: `$XDG_STATE_HOME/agent-relay/logs` (default
 *   `~/.local/state/agent-relay/logs`)
 * - Windows: `%LOCALAPPDATA%\agent-relay\Logs`
 */
export function getBrokerLogDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Logs', 'agent-relay');
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
      return join(localAppData, 'agent-relay', 'Logs');
    }
    default: {
      const stateHome =
        process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
          ? process.env.XDG_STATE_HOME
          : join(home, '.local', 'state');
      return join(stateHome, 'agent-relay', 'logs');
    }
  }
}

/** List all broker log files (current + rotated) in [`getBrokerLogDir`]. */
export async function listBrokerLogs(dir?: string): Promise<BrokerLogFile[]> {
  const logDir = dir ?? getBrokerLogDir();
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const files: BrokerLogFile[] = [];
  for (const name of entries) {
    const match = LOG_NAME_PATTERN.exec(name);
    if (!match || !match.groups) continue;
    const fullPath = join(logDir, name);
    let info;
    try {
      info = await stat(fullPath);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    files.push({
      path: fullPath,
      name,
      brokerId: match.groups.brokerId,
      date: match.groups.date ?? null,
      size: info.size,
      mtime: info.mtime,
    });
  }

  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files;
}

/**
 * Read the last `lines` lines of a broker's log. Picks the most recent file
 * matching `brokerId`. Returns `null` when no log file exists for that id.
 */
export async function tailBrokerLog(
  brokerId: string,
  options: { lines?: number; dir?: string } = {}
): Promise<{ path: string; content: string } | null> {
  const lines = options.lines ?? 200;
  const files = (await listBrokerLogs(options.dir)).filter((f) => f.brokerId === brokerId);
  if (files.length === 0) return null;
  const target = files[0]; // newest first
  return { path: target.path, content: await tailFile(target.path, lines) };
}

export interface PruneBrokerLogsOptions {
  /** Override the log directory. Defaults to [`getBrokerLogDir`]. */
  dir?: string;
  /**
   * Keep rotated files newer than this many days. `0` removes everything
   * except the current (un-suffixed) file. Default: 7.
   */
  keepDays?: number;
  /** When true, list candidates but don't delete. */
  dryRun?: boolean;
  /** Restrict to a single broker id. */
  brokerId?: string;
}

export interface PruneBrokerLogsResult {
  removed: BrokerLogFile[];
  kept: BrokerLogFile[];
}

/**
 * Delete rotated log files older than `keepDays` days. The current
 * un-suffixed file is always kept because `tracing-appender` is writing to it.
 */
export async function pruneBrokerLogs(options: PruneBrokerLogsOptions = {}): Promise<PruneBrokerLogsResult> {
  const keepDays = options.keepDays ?? 7;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const files = await listBrokerLogs(options.dir);
  const removed: BrokerLogFile[] = [];
  const kept: BrokerLogFile[] = [];

  for (const file of files) {
    if (options.brokerId && file.brokerId !== options.brokerId) {
      kept.push(file);
      continue;
    }
    // Never delete the current (un-suffixed) file — it's being written to.
    if (file.date === null) {
      kept.push(file);
      continue;
    }
    if (file.mtime.getTime() >= cutoff) {
      kept.push(file);
      continue;
    }
    if (!options.dryRun) {
      try {
        await unlink(file.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    removed.push(file);
  }

  return { removed, kept };
}

export interface ClearBrokerLogsOptions {
  dir?: string;
  /** Restrict to a single broker id. When omitted, removes all log files. */
  brokerId?: string;
  /** When true, list candidates but don't delete. */
  dryRun?: boolean;
}

/** Delete every log file (including the current one) matching the filter. */
export async function clearBrokerLogs(options: ClearBrokerLogsOptions = {}): Promise<BrokerLogFile[]> {
  const files = await listBrokerLogs(options.dir);
  const target = options.brokerId ? files.filter((f) => f.brokerId === options.brokerId) : files;

  if (options.dryRun) return target;

  for (const file of target) {
    try {
      await unlink(file.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return target;
}

async function tailFile(filePath: string, lines: number): Promise<string> {
  const CHUNK = 8192;
  let fh: FileHandle | undefined;
  try {
    fh = await open(filePath, 'r');
    const { size } = await fh.stat();
    if (size === 0) return '';

    if (size <= CHUNK) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      return tailLines(buf.toString('utf-8'), lines);
    }

    const chunks: Buffer[] = [];
    let position = size;
    let newlines = 0;
    while (position > 0 && newlines <= lines) {
      const readSize = Math.min(CHUNK, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, position);
      chunks.unshift(buf);
      newlines += countNewlines(buf);
    }
    const combined = Buffer.concat(chunks).toString('utf-8');
    return tailLines(combined, lines);
  } finally {
    if (fh) await fh.close();
  }
}

function tailLines(text: string, count: number): string {
  const split = text.split('\n');
  if (split.length > 0 && split[split.length - 1] === '') split.pop();
  return split.slice(-count).join('\n');
}

function countNewlines(buf: Buffer): number {
  let n = 0;
  for (const byte of buf) if (byte === 0x0a) n++;
  return n;
}
