import fs from 'node:fs';
import path from 'node:path';

import { Command, InvalidArgumentError } from 'commander';

import { getProjectPaths } from '@agent-relay/config';

import { defaultExit } from '../lib/exit.js';

type ExitFn = (code: number) => never;

type JsonObject = Record<string, unknown>;

interface DlqRecordEntry {
  fileName: string;
  filePath: string;
  record: JsonObject;
  summary: DlqRecordSummary;
}

interface DlqRecordSummary {
  eventId: string;
  type: string;
  error: string;
  attempts: number;
  firstSeen: string;
  lastSeen: string;
}

export interface DlqDependencies {
  getProjectRoot: () => string;
  fs: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readdirSync' | 'readFileSync' | 'unlinkSync'>;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
  now: () => number;
}

function withDefaults(overrides: Partial<DlqDependencies> = {}): DlqDependencies {
  return {
    getProjectRoot: () => getProjectPaths().projectRoot,
    fs,
    fetch,
    env: process.env,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    now: () => Date.now(),
    ...overrides,
  };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function normalizeTimestamp(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

function readObject(...values: unknown[]): JsonObject | undefined {
  for (const value of values) {
    if (isObject(value)) {
      return value;
    }
  }
  return undefined;
}

function parseDurationToMs(raw: string): number {
  const value = raw.trim().toLowerCase();
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/);
  if (!match) {
    throw new InvalidArgumentError('Expected duration like 30m, 12h, 7d, or 500ms.');
  }

  const amount = Number.parseFloat(match[1]);
  const unit = match[2];
  const multiplier =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1_000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : unit === 'd'
              ? 86_400_000
              : 604_800_000;

  return Math.floor(amount * multiplier);
}

function assertWorkspaceName(workspace: string): string {
  const trimmed = workspace.trim();
  if (!trimmed) {
    throw new InvalidArgumentError('Workspace name is required.');
  }
  return trimmed;
}

function resolveWorkspaceDir(projectRoot: string, workspace: string): string {
  const baseDir = path.resolve(projectRoot, '_dlq');
  const workspaceDir = path.resolve(baseDir, workspace);
  if (workspaceDir !== baseDir && !workspaceDir.startsWith(`${baseDir}${path.sep}`)) {
    throw new InvalidArgumentError('Workspace name must not escape the _dlq directory.');
  }
  return workspaceDir;
}

function summarizeDlqRecord(fileName: string, record: JsonObject): DlqRecordSummary {
  const event = readObject(record.event);
  const fileStem = path.basename(fileName, path.extname(fileName));
  const eventId =
    readString(record.eventId, record.event_id, event?.id, event?.eventId, event?.event_id, fileStem) ??
    fileStem;
  const type = readString(record.type, event?.type, record.eventType, record.event_type) ?? 'unknown';
  const errorValue = readObject(record.error);
  const error =
    readString(
      record.error,
      errorValue?.message,
      errorValue?.code,
      record.reason,
      record.lastError,
      record.last_error
    ) ?? 'unknown';
  const attempts = Math.max(
    1,
    Math.trunc(
      readNumber(
        record.attempts,
        record.attemptCount,
        record.attempt_count,
        readObject(record.delivery)?.attempts,
        readObject(record.delivery)?.attemptCount
      ) ?? 1
    )
  );
  const firstSeen =
    normalizeTimestamp(record.firstSeenAt, record.first_seen_at, record.createdAt, record.created_at) ??
    'unknown';
  const lastSeen =
    normalizeTimestamp(
      record.lastSeenAt,
      record.last_seen_at,
      record.updatedAt,
      record.updated_at,
      firstSeen
    ) ?? firstSeen;

  return { eventId, type, error, attempts, firstSeen, lastSeen };
}

function loadWorkspaceRecords(
  deps: DlqDependencies,
  workspace: string
): { workspaceDir: string; records: DlqRecordEntry[] } {
  const workspaceDir = resolveWorkspaceDir(deps.getProjectRoot(), assertWorkspaceName(workspace));
  if (!deps.fs.existsSync(workspaceDir)) {
    return { workspaceDir, records: [] };
  }

  const records = deps.fs
    .readdirSync(workspaceDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((fileName) => {
      const filePath = path.join(workspaceDir, fileName);
      const raw = deps.fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isObject(parsed)) {
        throw new Error(`DLQ record ${fileName} is not a JSON object.`);
      }
      return {
        fileName,
        filePath,
        record: parsed,
        summary: summarizeDlqRecord(fileName, parsed),
      };
    });

  records.sort((left, right) => {
    const leftTs = Date.parse(left.summary.lastSeen);
    const rightTs = Date.parse(right.summary.lastSeen);
    if (!Number.isNaN(leftTs) && !Number.isNaN(rightTs) && leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return left.summary.eventId.localeCompare(right.summary.eventId);
  });

  return { workspaceDir, records };
}

function findMatchingRecords(records: DlqRecordEntry[], eventId: string): DlqRecordEntry[] {
  const trimmed = eventId.trim();
  return records.filter(
    (entry) =>
      entry.summary.eventId === trimmed ||
      path.basename(entry.fileName, path.extname(entry.fileName)) === trimmed
  );
}

function resolveReplayRequest(
  record: JsonObject,
  env: NodeJS.ProcessEnv
): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
} {
  const gateway = readObject(record.gateway);
  const replay = readObject(
    record.replay,
    record.replay_request,
    gateway?.replay,
    gateway?.request,
    record.request
  );
  const baseUrl = readString(
    env.RELAY_DLQ_GATEWAY_URL,
    env.RELAY_GATEWAY_URL,
    env.OPENCLAW_GATEWAY_URL,
    record.gatewayUrl,
    record.gateway_url
  );
  const fullUrl = readString(replay?.url, record.replayUrl, record.replay_url);
  const requestPath = readString(replay?.path, replay?.endpoint, record.replayPath, record.replay_path);

  let url: string | undefined;
  if (fullUrl) {
    url = fullUrl;
  } else if (baseUrl && requestPath) {
    url = new URL(requestPath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  }

  if (!url) {
    throw new Error(
      'DLQ record does not include replay URL metadata. Add `replay.url` or provide RELAY_DLQ_GATEWAY_URL plus `replay.path`.'
    );
  }

  const method = readString(replay?.method, record.replayMethod, record.replay_method) ?? 'POST';
  const headerObject = readObject(replay?.headers, record.replayHeaders, record.replay_headers) ?? {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerObject)) {
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }

  const rawBody = replay?.body ?? record.event ?? record;
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    if (typeof rawBody === 'string') {
      body = rawBody;
    } else {
      body = JSON.stringify(rawBody);
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
  }

  return { url, method: method.toUpperCase(), headers, body };
}

async function replayRecord(
  deps: DlqDependencies,
  entry: DlqRecordEntry,
  workspace: string
): Promise<{ status: number; url: string }> {
  const request = resolveReplayRequest(
    {
      workspace,
      ...entry.record,
      event: isObject(entry.record.event) ? entry.record.event : entry.record.event,
    },
    deps.env
  );

  const response = await deps.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(
      `Replay failed for ${entry.summary.eventId}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`
    );
  }

  return { status: response.status, url: request.url };
}

export function registerDlqCommands(program: Command, overrides: Partial<DlqDependencies> = {}): void {
  const deps = withDefaults(overrides);
  const dlq = program.command('dlq').description('Inspect and manage dead-letter queue records');

  dlq
    .command('list')
    .description('List DLQ records for a workspace')
    .requiredOption('--workspace <name>', 'Workspace name')
    .action(async (options: { workspace: string }) => {
      try {
        const { records } = loadWorkspaceRecords(deps, options.workspace);
        if (records.length === 0) {
          deps.log(`No DLQ records found for workspace "${options.workspace}".`);
          return;
        }

        for (const entry of records) {
          deps.log(
            `${entry.summary.eventId} | ${entry.summary.type} | attempts=${entry.summary.attempts} | first=${entry.summary.firstSeen} | last=${entry.summary.lastSeen} | error=${entry.summary.error}`
          );
        }
      } catch (err: any) {
        deps.error(`Failed to list DLQ records: ${err?.message || String(err)}`);
        deps.exit(1);
      }
    });

  dlq
    .command('inspect')
    .description('Print the full DLQ record for an event')
    .requiredOption('--workspace <name>', 'Workspace name')
    .argument('<event-id>', 'Event id to inspect')
    .action(async (eventId: string, options: { workspace: string }) => {
      try {
        const { records } = loadWorkspaceRecords(deps, options.workspace);
        const matches = findMatchingRecords(records, eventId);
        if (matches.length === 0) {
          throw new Error(`No DLQ record found for event ${eventId}.`);
        }
        if (matches.length > 1) {
          throw new Error(
            `Multiple DLQ records found for event ${eventId}; inspect the files under _dlq manually.`
          );
        }

        deps.log(JSON.stringify(matches[0].record, null, 2));
      } catch (err: any) {
        deps.error(`Failed to inspect DLQ record: ${err?.message || String(err)}`);
        deps.exit(1);
      }
    });

  dlq
    .command('replay')
    .description('Replay one or more DLQ records into the gateway')
    .requiredOption('--workspace <name>', 'Workspace name')
    .option('--all', 'Replay every DLQ record in the workspace')
    .argument('[event-id]', 'Event id to replay')
    .action(async (eventId: string | undefined, options: { workspace: string; all?: boolean }) => {
      try {
        const { records } = loadWorkspaceRecords(deps, options.workspace);
        if (records.length === 0) {
          deps.log(`No DLQ records found for workspace "${options.workspace}".`);
          return;
        }

        let targets: DlqRecordEntry[];
        if (options.all) {
          targets = records;
        } else if (eventId) {
          targets = findMatchingRecords(records, eventId);
        } else {
          throw new InvalidArgumentError('Provide <event-id> or pass --all.');
        }

        if (targets.length === 0) {
          throw new Error(`No DLQ record found for event ${eventId}.`);
        }

        for (const entry of targets) {
          const result = await replayRecord(deps, entry, options.workspace);
          deps.log(`Replayed ${entry.summary.eventId} -> ${result.url} (${result.status})`);
        }
      } catch (err: any) {
        deps.error(`Failed to replay DLQ record: ${err?.message || String(err)}`);
        deps.exit(1);
      }
    });

  dlq
    .command('purge')
    .description('Delete DLQ records for a workspace')
    .requiredOption('--workspace <name>', 'Workspace name')
    .option('--older-than <duration>', 'Only purge records older than a duration', parseDurationToMs)
    .action(async (options: { workspace: string; olderThan?: number }) => {
      try {
        const { records } = loadWorkspaceRecords(deps, options.workspace);
        if (records.length === 0) {
          deps.log(`No DLQ records found for workspace "${options.workspace}".`);
          return;
        }

        const cutoff = typeof options.olderThan === 'number' ? deps.now() - options.olderThan : undefined;
        const targets = records.filter((entry) => {
          if (cutoff === undefined) return true;
          const ts = Date.parse(entry.summary.lastSeen);
          return !Number.isNaN(ts) && ts <= cutoff;
        });

        for (const entry of targets) {
          deps.fs.unlinkSync(entry.filePath);
        }

        deps.log(`Purged ${targets.length} DLQ record(s) from workspace "${options.workspace}".`);
      } catch (err: any) {
        deps.error(`Failed to purge DLQ records: ${err?.message || String(err)}`);
        deps.exit(1);
      }
    });
}
