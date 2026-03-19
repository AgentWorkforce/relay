import { createReadStream, existsSync, statSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import type {
  CliSessionCollector,
  CliSessionQuery,
  CliSessionReport,
} from '../cli-session-collector.js';

const CLAUDE_HOME = path.join(homedir(), '.claude');
const HISTORY_PATH = path.join(CLAUDE_HOME, 'history.jsonl');
const PROJECTS_PATH = path.join(CLAUDE_HOME, 'projects');
const HISTORY_LOOKBACK_MS = 5_000;

type JsonRecord = Record<string, unknown>;

interface ClaudeHistoryEntry {
  display?: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

export class ClaudeCodeCollector implements CliSessionCollector {
  canCollect(): boolean {
    return isReadableFile(HISTORY_PATH) && isReadableDirectory(PROJECTS_PATH);
  }

  async collect(query: CliSessionQuery): Promise<CliSessionReport | null> {
    const historyEntry = await findMatchingHistoryEntry(query);
    if (!historyEntry) {
      return null;
    }

    const sessionPath = path.join(
      PROJECTS_PATH,
      encodeProjectPath(historyEntry.project),
      `${historyEntry.sessionId}.jsonl`,
    );
    if (!(await isReadableFileAsync(sessionPath))) {
      return null;
    }

    return parseSessionLog(sessionPath, query, historyEntry.sessionId);
  }
}

async function findMatchingHistoryEntry(query: CliSessionQuery): Promise<ClaudeHistoryEntry | null> {
  const history = createInterface({
    input: createReadStream(HISTORY_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let match: ClaudeHistoryEntry | null = null;

  try {
    for await (const line of history) {
      const parsed = safeParseRecord(line);
      if (!parsed) {
        continue;
      }

      const entry = toHistoryEntry(parsed);
      if (!entry) {
        continue;
      }

      if (entry.project !== query.cwd) {
        continue;
      }

      if (entry.timestamp < query.startedAt - HISTORY_LOOKBACK_MS || entry.timestamp > query.completedAt) {
        continue;
      }

      match = entry;
    }
  } finally {
    history.close();
  }

  return match;
}

async function parseSessionLog(
  sessionPath: string,
  query: CliSessionQuery,
  sessionId: string,
): Promise<CliSessionReport | null> {
  const session = createInterface({
    input: createReadStream(sessionPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const rawLines: JsonRecord[] = [];
  const toolCalls = new Map<string, number>();
  const errors: { turn: number; text: string }[] = [];
  const tokens = { input: 0, output: 0, cacheRead: 0 };
  let turns = 0;
  let summary: string | null = null;
  let model: string | null = null;
  let provider: string | null = null;
  let finalStatus: CliSessionReport['finalStatus'] = 'unknown';

  try {
    for await (const line of session) {
      const parsed = safeParseRecord(line);
      if (!parsed) {
        continue;
      }

      rawLines.push(parsed);

      const entryType = getString(parsed.type);
      if (entryType === 'user') {
        turns += 1;
        continue;
      }

      if (entryType === 'assistant') {
        const usage = extractUsage(parsed);
        if (usage) {
          tokens.input += usage.input;
          tokens.output += usage.output;
          tokens.cacheRead += usage.cacheRead;
        }

        model ??= extractModel(parsed);
        provider ??= extractProvider(parsed);

        const assistantText = extractText(parsed);
        if (assistantText) {
          summary = assistantText;
          if (finalStatus !== 'failed') {
            finalStatus = 'completed';
          }
        }
        continue;
      }

      if (entryType === 'tool_use') {
        const toolName = extractToolName(parsed);
        if (toolName) {
          toolCalls.set(toolName, (toolCalls.get(toolName) ?? 0) + 1);
        }
        continue;
      }

      if (entryType === 'tool_result') {
        const errorText = extractErrorText(parsed);
        if (errorText) {
          errors.push({ turn: Math.max(turns, 1), text: errorText });
          finalStatus = 'failed';
        }
      }
    }
  } finally {
    session.close();
  }

  if (rawLines.length === 0) {
    return null;
  }

  return {
    cli: 'claude',
    sessionId,
    model,
    provider,
    durationMs: Math.max(query.completedAt - query.startedAt, 0),
    cost: null,
    tokens: tokens.input || tokens.output || tokens.cacheRead ? tokens : null,
    turns,
    toolCalls: Array.from(toolCalls, ([name, count]) => ({ name, count })),
    errors,
    finalStatus,
    summary,
    raw: {
      historyPath: HISTORY_PATH,
      sessionPath,
      lines: rawLines,
    },
  };
}

function toHistoryEntry(record: JsonRecord): ClaudeHistoryEntry | null {
  const timestamp = getNumber(record.timestamp);
  const project = getString(record.project);
  const sessionId = getString(record.sessionId);
  if (timestamp === null || !project || !sessionId) {
    return null;
  }

  return {
    display: getString(record.display) ?? undefined,
    timestamp,
    project,
    sessionId,
  };
}

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '--').replace(/^-+/, '');
}

function extractUsage(record: JsonRecord): { input: number; output: number; cacheRead: number } | null {
  const usage = findNestedRecord(record, [
    'usage',
    'message.usage',
    'metadata.usage',
    'message.metadata.usage',
  ]);
  if (!usage) {
    return null;
  }

  return {
    input: firstNumber(usage, ['input_tokens', 'inputTokens']) ?? 0,
    output: firstNumber(usage, ['output_tokens', 'outputTokens']) ?? 0,
    cacheRead: firstNumber(usage, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cache_read_tokens']) ?? 0,
  };
}

function extractModel(record: JsonRecord): string | null {
  return (
    getString(record.model)
    ?? getString(record.modelId)
    ?? getString(findNestedValue(record, ['message.model', 'message.modelId', 'metadata.model']))
  );
}

function extractProvider(record: JsonRecord): string | null {
  return (
    getString(record.provider)
    ?? getString(record.providerId)
    ?? getString(findNestedValue(record, ['message.provider', 'message.providerId', 'metadata.provider']))
    ?? 'anthropic'
  );
}

function extractToolName(record: JsonRecord): string | null {
  return (
    getString(record.name)
    ?? getString(record.tool_name)
    ?? getString(findNestedValue(record, ['tool.name', 'content.name']))
  );
}

function extractErrorText(record: JsonRecord): string | null {
  const candidates = [
    getString(record.error),
    getString(findNestedValue(record, ['content.error', 'result.error', 'data.error', 'payload.error'])),
    extractText(record),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeError(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function extractText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    const texts = value
      .map((entry) => extractText(entry))
      .filter((entry): entry is string => Boolean(entry));
    return texts.length > 0 ? texts.join('\n').trim() : null;
  }

  const record = value as JsonRecord;

  if (typeof record.text === 'string' && record.text.trim()) {
    return record.text.trim();
  }

  if (typeof record.content === 'string' && record.content.trim()) {
    return record.content.trim();
  }

  if (Array.isArray(record.content)) {
    const texts = record.content
      .map((entry) => extractText(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (texts.length > 0) {
      return texts.join('\n').trim();
    }
  }

  if (record.message && typeof record.message === 'object') {
    return extractText(record.message);
  }

  return null;
}

function normalizeError(text: string | null): string | null {
  if (!text) {
    return null;
  }

  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /(?:^error\b|^error:|^command failed\b|^fail\b|exception|traceback)/i.test(entry));

  return line ?? null;
}

function safeParseRecord(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed as JsonRecord;
  } catch {
    return null;
  }
}

function findNestedRecord(root: JsonRecord, paths: string[]): JsonRecord | null {
  for (const candidate of paths) {
    const value = findNestedValue(root, [candidate]);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonRecord;
    }
  }

  return null;
}

function findNestedValue(root: JsonRecord, paths: string[]): unknown {
  for (const candidate of paths) {
    let current: unknown = root;
    let found = true;

    for (const segment of candidate.split('.')) {
      if (!current || typeof current !== 'object' || Array.isArray(current) || !(segment in current)) {
        found = false;
        break;
      }
      current = (current as JsonRecord)[segment];
    }

    if (found) {
      return current;
    }
  }

  return undefined;
}

function firstNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isReadableFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isReadableDirectory(dirPath: string): boolean {
  try {
    return existsSync(dirPath) && statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

async function isReadableFileAsync(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
