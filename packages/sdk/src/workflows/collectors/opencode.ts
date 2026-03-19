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
const OPENCODE_DB_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const MATCH_WINDOW_GRACE_MS = 5_000;
const ERROR_LINE_PATTERN = /^(Error|error:|Command failed|FAIL)\b/;

type DatabaseInstance = {
  prepare(sql: string): {
    get<T>(params?: unknown): T | undefined;
    all<T>(params?: unknown): T[];
  };
  pragma(source: string): unknown;
  close(): void;
};

type DatabaseConstructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => DatabaseInstance;

interface SessionRow {
  id: string;
  directory: string;
  time_created: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface OpenCodeMessageData {
  role?: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  finish?: string;
  tokens?: {
    input?: number;
    output?: number;
    cache?: {
      read?: number;
    };
  };
}

interface OpenCodePartData {
  type?: string;
  text?: string;
  name?: string;
}

function loadDatabaseConstructor(): DatabaseConstructor | null {
  try {
    return require('better-sqlite3') as DatabaseConstructor;
  } catch {
    return null;
  }
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeStatus(finish: string | undefined, hasErrors: boolean): CliSessionReport['finalStatus'] {
  if (finish === 'stop' || finish === 'completed') {
    return 'completed';
  }

  if (finish === 'error' || finish === 'failed' || hasErrors) {
    return 'failed';
  }

  return 'unknown';
}

function isToolPart(part: OpenCodePartData | null): part is OpenCodePartData {
  return !!part?.type && part.type.toLowerCase().includes('tool');
}

export class OpenCodeCollector implements CliSessionCollector {
  canCollect(): boolean {
    if (!fs.existsSync(OPENCODE_DB_PATH)) {
      return false;
    }

    const Database = loadDatabaseConstructor();
    if (!Database) {
      return false;
    }

    let db: DatabaseInstance | null = null;

    try {
      db = new Database(OPENCODE_DB_PATH, { readonly: true, fileMustExist: true });
      db.pragma('query_only = ON');
      db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  async collect(query: CliSessionQuery): Promise<CliSessionReport | null> {
    const Database = loadDatabaseConstructor();
    if (!Database) {
      return null;
    }

    let db: DatabaseInstance | null = null;

    try {
      db = new Database(OPENCODE_DB_PATH, { readonly: true, fileMustExist: true });
      db.pragma('query_only = ON');

      const session = db.prepare(
        `
          SELECT id, directory, time_created
          FROM session
          WHERE directory = @cwd
            AND time_created BETWEEN @startedAt AND @completedAt
          ORDER BY time_created DESC
          LIMIT 1
        `,
      ).get<SessionRow>({
        cwd: query.cwd,
        startedAt: query.startedAt - MATCH_WINDOW_GRACE_MS,
        completedAt: query.completedAt,
      });

      if (!session) {
        return null;
      }

      const messages = db.prepare(
        `
          SELECT id, session_id, time_created, data
          FROM message
          WHERE session_id = ?
          ORDER BY time_created ASC
        `,
      ).all<MessageRow>(session.id);

      const parts = db.prepare(
        `
          SELECT id, message_id, session_id, time_created, data
          FROM part
          WHERE session_id = ?
          ORDER BY time_created ASC
        `,
      ).all<PartRow>(session.id);

      const parsedMessages = messages.map((message) => ({
        ...message,
        parsed: parseJson<OpenCodeMessageData>(message.data),
      }));
      const parsedParts = parts.map((part) => ({
        ...part,
        parsed: parseJson<OpenCodePartData>(part.data),
      }));

      const lastMessageWithMetadata = [...parsedMessages]
        .reverse()
        .find((message) => message.parsed?.modelID || message.parsed?.providerID || message.parsed?.finish);

      const tokenTotals = parsedMessages.reduce(
        (totals, message) => {
          const tokens = message.parsed?.tokens;
          totals.input += toNumber(tokens?.input);
          totals.output += toNumber(tokens?.output);
          totals.cacheRead += toNumber(tokens?.cache?.read);
          return totals;
        },
        { input: 0, output: 0, cacheRead: 0 },
      );

      const totalCost = parsedMessages.reduce((sum, message) => sum + toNumber(message.parsed?.cost), 0);

      const toolCallCounts = new Map<string, number>();
      for (const part of parsedParts) {
        if (!isToolPart(part.parsed)) {
          continue;
        }

        const name = part.parsed.name?.trim();
        if (!name) {
          continue;
        }

        toolCallCounts.set(name, (toolCallCounts.get(name) ?? 0) + 1);
      }

      const errors: CliSessionReport['errors'] = [];
      for (const [index, part] of parsedParts.entries()) {
        const text = part.parsed?.type === 'text' ? part.parsed.text : undefined;
        if (!text) {
          continue;
        }

        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || !ERROR_LINE_PATTERN.test(trimmed)) {
            continue;
          }

          errors.push({ turn: index + 1, text: trimmed });
        }
      }

      const summary = [...parsedParts]
        .reverse()
        .find((part) => part.parsed?.type === 'text' && part.parsed.text?.trim())?.parsed?.text?.trim() ?? null;

      const turns = parsedMessages.filter(
        (message) => message.parsed?.role === 'assistant' || message.parsed?.role === 'user',
      ).length || parsedMessages.length;

      return {
        cli: 'opencode',
        sessionId: session.id,
        model: lastMessageWithMetadata?.parsed?.modelID ?? null,
        provider: lastMessageWithMetadata?.parsed?.providerID ?? null,
        durationMs:
          parsedMessages.length > 0
            ? Math.max(0, parsedMessages[parsedMessages.length - 1].time_created - session.time_created)
            : null,
        cost: totalCost > 0 ? totalCost : 0,
        tokens: tokenTotals,
        turns,
        toolCalls: [...toolCallCounts.entries()].map(([name, count]) => ({ name, count })),
        errors,
        finalStatus: normalizeStatus(lastMessageWithMetadata?.parsed?.finish, errors.length > 0),
        summary,
        raw: {
          session,
          messages: parsedMessages.map(({ parsed, ...message }) => ({ ...message, data: parsed ?? message.data })),
          parts: parsedParts.map(({ parsed, ...part }) => ({ ...part, data: parsed ?? part.data })),
        },
      };
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }
}
