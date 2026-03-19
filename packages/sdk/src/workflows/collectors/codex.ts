import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import type {
  CliSessionCollector,
  CliSessionQuery,
  CliSessionReport,
} from '../cli-session-collector.js';

const require = createRequire(import.meta.url);
const CODEX_HOME = path.join(os.homedir(), '.codex');
const DEFAULT_HISTORY_PATH = path.join(CODEX_HOME, 'history.jsonl');
const DEFAULT_STATE_PATH = path.join(CODEX_HOME, 'state_5.sqlite');

type DatabaseInstance = {
  prepare(sql: string): {
    all<T>(params?: unknown): T[];
  };
  close?: () => void;
};

type DatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => DatabaseInstance;

interface DatabaseSyncModule {
  DatabaseSync: new (
    filename: string,
    options?: { readonly?: boolean; open?: boolean },
  ) => DatabaseInstance;
}

interface CodexCollectorOptions {
  historyPath?: string;
  statePath?: string;
}

interface HistoryEntry {
  session_id?: string;
  ts?: number;
  text?: string;
}

interface ThreadRow {
  id: string;
  cwd: string;
  model_provider: string;
  tokens_used: number;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

interface LogRow {
  ts?: number;
  level?: string;
  message?: string | null;
  line?: number | null;
}

function loadBetterSqlite3(): DatabaseConstructor | null {
  try {
    return require('better-sqlite3') as DatabaseConstructor;
  } catch {
    return null;
  }
}

async function openDatabase(dbPath: string): Promise<DatabaseInstance | null> {
  const BetterSqlite = loadBetterSqlite3();
  if (BetterSqlite) {
    try {
      return new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      // Fall through to node:sqlite.
    }
  }

  try {
    const sqlite = (await import('node:sqlite')) as DatabaseSyncModule;
    return new sqlite.DatabaseSync(dbPath, { readonly: true, open: true });
  } catch {
    return null;
  }
}

function normalizeTimestamp(value: unknown): number | null {
  const numeric = typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : null;
  if (numeric === null || !Number.isFinite(numeric)) {
    return null;
  }

  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

function parseModelProvider(value: string | null | undefined): { provider: string | null; model: string | null } {
  if (!value) {
    return { provider: null, model: null };
  }

  if (value.includes('/')) {
    const [provider, ...rest] = value.split('/');
    return {
      provider: provider || null,
      model: rest.join('/') || null,
    };
  }

  if (value.includes(':')) {
    const [provider, ...rest] = value.split(':');
    return {
      provider: provider || null,
      model: rest.join(':') || null,
    };
  }

  return {
    provider: value,
    model: null,
  };
}

function getNumericField(row: ThreadRow, fieldNames: string[]): number | null {
  for (const fieldName of fieldNames) {
    const value = row[fieldName];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function extractTokens(row: ThreadRow): CliSessionReport['tokens'] {
  const input = getNumericField(row, ['input_tokens', 'prompt_tokens', 'tokens_input']);
  const output = getNumericField(row, ['output_tokens', 'completion_tokens', 'tokens_output']);
  const cacheRead = getNumericField(row, ['cache_read_tokens', 'tokens_cache_read', 'cached_input_tokens']);

  if (input !== null || output !== null || cacheRead !== null) {
    return {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: cacheRead ?? 0,
    };
  }

  return typeof row.tokens_used === 'number'
    ? {
        input: row.tokens_used,
        output: 0,
        cacheRead: 0,
      }
    : null;
}

export class CodexCollector implements CliSessionCollector {
  private readonly historyPath: string;
  private readonly statePath: string;

  constructor(options: CodexCollectorOptions = {}) {
    this.historyPath = options.historyPath ?? DEFAULT_HISTORY_PATH;
    this.statePath = options.statePath ?? DEFAULT_STATE_PATH;
  }

  canCollect(): boolean {
    return fs.existsSync(this.statePath) || fs.existsSync(this.historyPath);
  }

  async collect(query: CliSessionQuery): Promise<CliSessionReport | null> {
    const historyEntries = this.readHistoryEntries();
    const matchedThread = await this.findMatchingThread(query);

    if (matchedThread) {
      const errors = await this.readThreadErrors(matchedThread.id);
      const { provider, model } = parseModelProvider(matchedThread.model_provider);
      const createdAtMs = normalizeTimestamp(matchedThread.created_at);
      const updatedAtMs = normalizeTimestamp(matchedThread.updated_at);

      return {
        cli: 'codex',
        sessionId: matchedThread.id,
        model,
        provider,
        durationMs:
          createdAtMs !== null && updatedAtMs !== null && updatedAtMs >= createdAtMs
            ? updatedAtMs - createdAtMs
            : Math.max(query.completedAt - query.startedAt, 0),
        cost: null,
        tokens: extractTokens(matchedThread),
        turns: historyEntries.filter((entry) => entry.session_id === matchedThread.id).length,
        toolCalls: [],
        errors,
        finalStatus: errors.length > 0 ? 'failed' : 'unknown',
        summary: null,
        raw: {
          matchedVia: 'threads',
          thread: matchedThread,
        },
      };
    }

    const historyMatch = this.findMatchingHistoryEntry(query, historyEntries);
    if (!historyMatch) {
      return null;
    }

    return {
      cli: 'codex',
      sessionId: historyMatch.session_id ?? null,
      model: null,
      provider: null,
      durationMs: Math.max(query.completedAt - query.startedAt, 0),
      cost: null,
      tokens: null,
      turns: historyMatch.session_id
        ? historyEntries.filter((entry) => entry.session_id === historyMatch.session_id).length
        : 0,
      toolCalls: [],
      errors: [],
      finalStatus: 'unknown',
      summary: null,
      raw: {
        matchedVia: 'history',
        entry: historyMatch,
      },
    };
  }

  private readHistoryEntries(): HistoryEntry[] {
    if (!fs.existsSync(this.historyPath)) {
      return [];
    }

    try {
      return fs.readFileSync(this.historyPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const parsed = parseJsonLine<HistoryEntry>(line);
          return parsed ? [parsed] : [];
        });
    } catch {
      return [];
    }
  }

  private findMatchingHistoryEntry(query: CliSessionQuery, entries: HistoryEntry[]): HistoryEntry | null {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const timestamp = normalizeTimestamp(entry.ts);
      if (timestamp === null) {
        continue;
      }

      if (timestamp >= query.startedAt && timestamp <= query.completedAt) {
        return entry;
      }
    }

    return null;
  }

  private async findMatchingThread(query: CliSessionQuery): Promise<ThreadRow | null> {
    if (!fs.existsSync(this.statePath)) {
      return null;
    }

    const db = await openDatabase(this.statePath);
    if (!db) {
      return null;
    }

    try {
      const threads = db.prepare(
        `
          SELECT *
          FROM threads
          WHERE cwd = ?
          ORDER BY created_at DESC
          LIMIT 100
        `,
      ).all<ThreadRow>(query.cwd);

      return threads.find((thread) => {
        const createdAt = normalizeTimestamp(thread.created_at);
        return createdAt !== null && createdAt >= query.startedAt && createdAt <= query.completedAt;
      }) ?? null;
    } catch {
      return null;
    } finally {
      db.close?.();
    }
  }

  private async readThreadErrors(threadId: string): Promise<CliSessionReport['errors']> {
    if (!fs.existsSync(this.statePath)) {
      return [];
    }

    const db = await openDatabase(this.statePath);
    if (!db) {
      return [];
    }

    try {
      const rows = db.prepare(
        `
          SELECT ts, level, message, line
          FROM logs
          WHERE thread_id = ?
            AND lower(level) = 'error'
          ORDER BY ts ASC
        `,
      ).all<LogRow>(threadId);

      return rows
        .map((row, index) => {
          const message = typeof row.message === 'string' ? row.message.trim() : '';
          if (!message) {
            return null;
          }

          return {
            turn: index + 1,
            text: message,
          };
        })
        .filter((row): row is { turn: number; text: string } => row !== null);
    } catch {
      return [];
    } finally {
      db.close?.();
    }
  }
}
