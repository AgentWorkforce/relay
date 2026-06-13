import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildApiUrl } from './api-client.js';
import { defaultApiUrl } from './types.js';

export type WorkerFileType = 'yaml' | 'ts' | 'py';

export type WorkerWorkflowPayload = {
  runId: string;
  workspaceId: string;
  relayWorkspaceId: string;
  relaycastApiKey: string;
  relaycastBaseUrl?: string;
  relayfileUrl: string;
  relayfileToken: string;
  workflow: string;
  fileType: WorkerFileType;
  sourceFileType: WorkerFileType | 'workflow';
  workflowFileName: string;
  envSecrets?: Record<string, string>;
  metadata?: Record<string, string>;
  s3CodeKey?: string;
  paths?: Array<{
    name: string;
    s3CodeKey: string;
    repoOwner?: string;
    repoName?: string;
  }>;
  resumeRunId?: string;
  startFrom?: string;
  previousRunId?: string;
};

export type WorkerWorkflowRef = {
  type: 'inline' | 'url';
  value: string;
};

export type WorkAssignmentRecord = {
  id: string;
  workspaceId: string;
  workerId: string | null;
  runId: string;
  workflowRef: WorkerWorkflowRef;
  status: 'queued' | 'assigned' | 'running' | 'completed' | 'failed' | 'timeout';
  queuedAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  queueDeadline: string;
  result?: Record<string, unknown>;
  error?: string;
};

export type CloudWorkerRecord = {
  baseUrl: string;
  workerId: string;
  workerToken: string;
  name: string;
  heartbeatIntervalMs: number;
  registeredAt: string;
  updatedAt: string;
  pid?: number;
  logPath?: string;
};

export type CloudWorkerStore = {
  active?: Record<string, string>;
  workers: Record<string, CloudWorkerRecord>;
};

export type WorkerStatusDetail = {
  phase: 'running' | 'completed' | 'failed';
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  result?: Record<string, unknown>;
};

export type WorkerQueueEvent =
  | { type: 'assignment'; assignment: WorkAssignmentRecord }
  | { type: 'timeout'; assignment: WorkAssignmentRecord }
  | { type: 'revoke' }
  | { type: 'ping' };

export type ExecuteWorkerAssignment = (input: {
  assignment: WorkAssignmentRecord;
  payload: WorkerWorkflowPayload;
  signal: AbortSignal;
}) => Promise<{
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  result?: Record<string, unknown>;
}>;

export type CloudWorkerLoopOptions = {
  worker: CloudWorkerRecord;
  executeAssignment: ExecuteWorkerAssignment;
  once?: boolean;
  signal?: AbortSignal;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const RESERVED_WORKER_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const QUEUE_RECONNECT_MS = 2_000;
const MAX_SEEN_RUN_IDS = 1_000;

function ensurePlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function normalizeBaseUrl(value?: string): string {
  const raw = trimTrailingSlashes(value?.trim() || defaultApiUrl());
  if (!raw) {
    throw new Error('Cloud API base URL is required.');
  }
  try {
    return trimTrailingSlashes(new URL(raw).toString());
  } catch {
    throw new Error(`Invalid Cloud API base URL: ${raw}`);
  }
}

function normalizeWorkerName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error('Worker name is required.');
  }
  if (name.length > 128) {
    throw new Error('Worker name must be 128 characters or fewer.');
  }
  if (RESERVED_WORKER_NAMES.has(name)) {
    throw new Error(`Invalid worker name "${name}".`);
  }
  return name;
}

function cloudHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_RELAY_HOME ?? path.join(os.homedir(), '.agentworkforce/relay');
}

export function cloudWorkerStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cloudHome(env), 'cloud-workers.json');
}

export function cloudWorkerStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(cloudHome(env), 'cloud-workers');
}

function workerKey(baseUrl: string, workerId: string): string {
  return `${baseUrl}#${workerId}`;
}

function activeBaseKey(baseUrl: string): string {
  return baseUrl;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isCloudWorkerRecord(value: unknown): value is CloudWorkerRecord {
  if (!ensurePlainObject(value)) return false;
  return (
    typeof value.baseUrl === 'string' &&
    typeof value.workerId === 'string' &&
    typeof value.workerToken === 'string' &&
    typeof value.name === 'string' &&
    typeof value.heartbeatIntervalMs === 'number' &&
    typeof value.registeredAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

export function readCloudWorkerStore(env: NodeJS.ProcessEnv = process.env): CloudWorkerStore {
  const file = cloudWorkerStorePath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (!ensurePlainObject(parsed)) {
      return { active: {}, workers: {} };
    }
    const workers: Record<string, CloudWorkerRecord> = {};
    const rawWorkers = ensurePlainObject(parsed.workers) ? parsed.workers : {};
    for (const [key, value] of Object.entries(rawWorkers)) {
      if (isCloudWorkerRecord(value)) {
        workers[key] = value;
      }
    }
    const active: Record<string, string> = {};
    const rawActive = ensurePlainObject(parsed.active) ? parsed.active : {};
    for (const [key, value] of Object.entries(rawActive)) {
      if (typeof value === 'string') {
        active[key] = value;
      }
    }
    return { active, workers };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { active: {}, workers: {} };
    }
    throw error;
  }
}

export function writeCloudWorkerStore(store: CloudWorkerStore, env: NodeJS.ProcessEnv = process.env): void {
  const file = cloudWorkerStorePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function upsertCloudWorkerRecord(
  worker: CloudWorkerRecord,
  env: NodeJS.ProcessEnv = process.env
): CloudWorkerStore {
  const store = readCloudWorkerStore(env);
  const key = workerKey(worker.baseUrl, worker.workerId);
  store.workers[key] = worker;
  store.active ??= {};
  store.active[activeBaseKey(worker.baseUrl)] = key;
  writeCloudWorkerStore(store, env);
  return store;
}

export function resolveCloudWorkerRecord(
  input: {
    baseUrl?: string;
    workerId?: string;
    name?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): CloudWorkerRecord {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const store = readCloudWorkerStore(input.env);
  if (input.workerId) {
    const record = store.workers[workerKey(baseUrl, input.workerId.trim())];
    if (!record) {
      throw new Error(`No stored cloud worker found for ${input.workerId.trim()} at ${baseUrl}.`);
    }
    return record;
  }

  if (input.name) {
    const name = input.name.trim();
    const records = Object.values(store.workers).filter(
      (record) => record.baseUrl === baseUrl && record.name === name
    );
    if (records.length === 1) {
      return records[0];
    }
    if (records.length > 1) {
      throw new Error(`Multiple stored workers named "${name}" at ${baseUrl}; pass --worker-id.`);
    }
    throw new Error(`No stored cloud worker named "${name}" at ${baseUrl}.`);
  }

  const activeKey = store.active?.[activeBaseKey(baseUrl)];
  const active = activeKey ? store.workers[activeKey] : undefined;
  if (!active) {
    throw new Error(`No active cloud worker is stored for ${baseUrl}. Run cloud worker register first.`);
  }
  return active;
}

function workerHeaders(workerToken: string, headers?: HeadersInit): Headers {
  const merged = new Headers(headers);
  merged.set('Authorization', `Bearer ${workerToken}`);
  return merged;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  const text = await response.text().catch(() => '');
  return text ? { error: text } : null;
}

function responseError(response: Response, payload: unknown): Error {
  const message =
    ensurePlainObject(payload) && typeof payload.error === 'string'
      ? payload.error
      : `${response.status} ${response.statusText}`.trim();
  return new Error(message);
}

function validHeartbeatIntervalMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

export async function registerCloudWorker(input: {
  enrollmentToken: string;
  name: string;
  baseUrl?: string;
  hostInfo?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<CloudWorkerRecord> {
  const fetcher = input.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const name = normalizeWorkerName(input.name);
  const response = await fetcher(buildApiUrl(baseUrl, '/api/v1/workers/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enrollmentToken: input.enrollmentToken.trim(),
      name,
      ...(input.hostInfo ? { hostInfo: input.hostInfo } : {}),
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw responseError(response, payload);
  }
  if (!ensurePlainObject(payload)) {
    throw new Error('Worker registration returned an invalid response.');
  }
  const workerId = payload.workerId;
  const workerToken = payload.workerToken;
  const heartbeatIntervalMs = payload.heartbeatIntervalMs;
  if (
    typeof workerId !== 'string' ||
    typeof workerToken !== 'string' ||
    typeof heartbeatIntervalMs !== 'number'
  ) {
    throw new Error('Worker registration response is missing worker credentials.');
  }

  const now = new Date().toISOString();
  const record: CloudWorkerRecord = {
    baseUrl,
    workerId,
    workerToken,
    name,
    heartbeatIntervalMs,
    registeredAt: now,
    updatedAt: now,
  };
  upsertCloudWorkerRecord(record, input.env);
  return record;
}

export async function sendCloudWorkerHeartbeat(input: {
  worker: CloudWorkerRecord;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ nextHeartbeatMs: number }> {
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher(
    buildApiUrl(
      input.worker.baseUrl,
      `/api/v1/workers/${encodeURIComponent(input.worker.workerId)}/heartbeat`
    ),
    {
      method: 'POST',
      headers: workerHeaders(input.worker.workerToken),
      signal: input.signal,
    }
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw responseError(response, payload);
  }
  const requestedHeartbeatMs =
    ensurePlainObject(payload) && validHeartbeatIntervalMs(payload.nextHeartbeatMs)
      ? payload.nextHeartbeatMs
      : input.worker.heartbeatIntervalMs;
  const nextHeartbeatMs = validHeartbeatIntervalMs(requestedHeartbeatMs)
    ? requestedHeartbeatMs
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  return { nextHeartbeatMs };
}

export async function acknowledgeCloudWorkerAssignment(input: {
  worker: CloudWorkerRecord;
  runId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher(
    buildApiUrl(
      input.worker.baseUrl,
      `/api/v1/workers/${encodeURIComponent(input.worker.workerId)}/assignments/${encodeURIComponent(
        input.runId
      )}/ack`
    ),
    {
      method: 'POST',
      headers: workerHeaders(input.worker.workerToken),
    }
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw responseError(response, payload);
  }
}

export async function reportCloudWorkerAssignmentStatus(input: {
  worker: CloudWorkerRecord;
  runId: string;
  status: WorkerStatusDetail;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher(
    buildApiUrl(
      input.worker.baseUrl,
      `/api/v1/workers/${encodeURIComponent(input.worker.workerId)}/assignments/${encodeURIComponent(
        input.runId
      )}/status`
    ),
    {
      method: 'POST',
      headers: workerHeaders(input.worker.workerToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(input.status),
    }
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw responseError(response, payload);
  }
}

function isWorkflowRef(value: unknown): value is WorkerWorkflowRef {
  if (!ensurePlainObject(value)) return false;
  return (
    (value.type === 'inline' || value.type === 'url') &&
    typeof value.value === 'string' &&
    value.value.trim().length > 0
  );
}

function isWorkerWorkflowPayload(value: unknown): value is WorkerWorkflowPayload {
  if (!ensurePlainObject(value)) return false;
  return (
    typeof value.runId === 'string' &&
    typeof value.workspaceId === 'string' &&
    typeof value.relayWorkspaceId === 'string' &&
    typeof value.relaycastApiKey === 'string' &&
    typeof value.relayfileUrl === 'string' &&
    typeof value.relayfileToken === 'string' &&
    typeof value.workflow === 'string' &&
    (value.fileType === 'yaml' || value.fileType === 'ts' || value.fileType === 'py') &&
    (value.sourceFileType === 'yaml' ||
      value.sourceFileType === 'ts' ||
      value.sourceFileType === 'py' ||
      value.sourceFileType === 'workflow') &&
    typeof value.workflowFileName === 'string'
  );
}

export async function resolveWorkerWorkflowPayload(input: {
  workflowRef: WorkerWorkflowRef;
  worker?: CloudWorkerRecord;
  fetchImpl?: typeof fetch;
}): Promise<WorkerWorkflowPayload> {
  if (!isWorkflowRef(input.workflowRef)) {
    throw new Error('Assignment is missing a valid workflowRef.');
  }

  let raw: unknown;
  if (input.workflowRef.type === 'inline') {
    raw = JSON.parse(input.workflowRef.value);
  } else {
    const fetcher = input.fetchImpl ?? fetch;
    const headers =
      input.worker && sameOrigin(input.workflowRef.value, input.worker.baseUrl)
        ? workerHeaders(input.worker.workerToken)
        : undefined;
    const response = await fetcher(input.workflowRef.value, {
      headers,
    });
    raw = await readJsonResponse(response);
    if (!response.ok) {
      throw responseError(response, raw);
    }
  }

  if (!isWorkerWorkflowPayload(raw)) {
    throw new Error('Resolved worker workflow payload is invalid.');
  }
  return raw;
}

function parseSseEvent(event: string, data: string): WorkerQueueEvent | null {
  if (event === 'ping') {
    return { type: 'ping' };
  }
  if (event === 'revoke') {
    return { type: 'revoke' };
  }

  const payload = data ? (JSON.parse(data) as unknown) : {};
  if (event === 'assignment' || event === 'timeout') {
    if (
      !ensurePlainObject(payload) ||
      !isWorkflowRef(payload.workflowRef) ||
      typeof payload.runId !== 'string'
    ) {
      throw new Error(`Invalid worker ${event} event payload.`);
    }
    return { type: event, assignment: payload as WorkAssignmentRecord };
  }

  return null;
}

export async function* streamCloudWorkerQueue(input: {
  worker: CloudWorkerRecord;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): AsyncGenerator<WorkerQueueEvent> {
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher(
    buildApiUrl(input.worker.baseUrl, `/api/v1/workers/${encodeURIComponent(input.worker.workerId)}/queue`),
    {
      method: 'GET',
      headers: workerHeaders(input.worker.workerToken),
      signal: input.signal,
    }
  );
  if (!response.ok) {
    const payload = await readJsonResponse(response);
    throw responseError(response, payload);
  }
  if (!response.body) {
    throw new Error('Worker queue response did not include a stream body.');
  }

  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let buffer = '';
    let event = 'message';
    let data = '';

    const flush = (): WorkerQueueEvent | null => {
      const currentEvent = event;
      const currentData = data.replace(/\n$/, '');
      event = 'message';
      data = '';
      if (!currentData && currentEvent === 'message') {
        return null;
      }
      return parseSseEvent(currentEvent, currentData);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.search(/\r?\n/)) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        const nextOffset = buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(newlineIndex + nextOffset);
        const line = rawLine.trimEnd();
        if (!line) {
          const parsed = flush();
          if (parsed) {
            yield parsed;
          }
          continue;
        }
        if (line.startsWith(':')) {
          continue;
        }
        const colonIndex = line.indexOf(':');
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
        const valueText = colonIndex === -1 ? '' : line.slice(colonIndex + 1).replace(/^ /, '');
        if (field === 'event') {
          event = valueText || 'message';
        } else if (field === 'data') {
          data += `${valueText}\n`;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function toShortError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message.slice(0, 500);
  }
  return String(error).slice(0, 500);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCloudWorkerLoop(options: CloudWorkerLoopOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const seenRunIds = new Set<string>();
  let heartbeatMs = options.worker.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
  let stopped = false;
  let wakeHeartbeat: (() => void) | undefined;
  const heartbeatAbort = new AbortController();

  const sleepUntilStopped = async (ms: number): Promise<void> => {
    if (stopped || options.signal?.aborted) return;
    await Promise.race([
      sleep(ms),
      new Promise<void>((resolve) => {
        wakeHeartbeat = resolve;
      }),
    ]);
    wakeHeartbeat = undefined;
  };

  const heartbeat = async () => {
    while (!stopped && !options.signal?.aborted) {
      try {
        const result = await sendCloudWorkerHeartbeat({
          worker: options.worker,
          fetchImpl,
          signal: heartbeatAbort.signal,
        });
        heartbeatMs = result.nextHeartbeatMs;
      } catch (error) {
        if (stopped || heartbeatAbort.signal.aborted || options.signal?.aborted) {
          return;
        }
        options.log?.(`Heartbeat failed: ${toShortError(error)}`);
      }
      await sleepUntilStopped(heartbeatMs);
    }
  };

  const heartbeatPromise = heartbeat();
  try {
    while (!options.signal?.aborted) {
      try {
        for await (const event of streamCloudWorkerQueue({
          worker: options.worker,
          fetchImpl,
          signal: options.signal,
        })) {
          if (options.signal?.aborted) {
            return;
          }
          if (event.type === 'ping') {
            continue;
          }
          if (event.type === 'revoke') {
            options.log?.('Worker was revoked by Cloud; stopping.');
            return;
          }
          if (event.type === 'timeout') {
            options.log?.(`Assignment ${event.assignment.runId} timed out before execution.`);
            continue;
          }

          const assignment = event.assignment;
          if (seenRunIds.has(assignment.runId)) {
            options.log?.(`Ignoring duplicate assignment for run ${assignment.runId}.`);
            continue;
          }
          const startedAt = Date.now();
          try {
            await acknowledgeCloudWorkerAssignment({
              worker: options.worker,
              runId: assignment.runId,
              fetchImpl,
            });
            seenRunIds.add(assignment.runId);
            if (seenRunIds.size > MAX_SEEN_RUN_IDS) {
              const oldest = seenRunIds.values().next().value;
              if (oldest !== undefined) {
                seenRunIds.delete(oldest);
              }
            }
            const payload = await resolveWorkerWorkflowPayload({
              workflowRef: assignment.workflowRef,
              worker: options.worker,
              fetchImpl,
            });
            await reportCloudWorkerAssignmentStatus({
              worker: options.worker,
              runId: assignment.runId,
              fetchImpl,
              status: { phase: 'running' },
            });
            const result = await options.executeAssignment({
              assignment,
              payload,
              signal: options.signal ?? new AbortController().signal,
            });
            await reportCloudWorkerAssignmentStatus({
              worker: options.worker,
              runId: assignment.runId,
              fetchImpl,
              status: {
                phase: 'completed',
                exitCode: result.exitCode ?? 0,
                durationMs: result.durationMs ?? Date.now() - startedAt,
                summary: result.summary,
                result: result.result,
              },
            });
            options.log?.(`Assignment ${assignment.runId} completed.`);
          } catch (error) {
            await reportCloudWorkerAssignmentStatus({
              worker: options.worker,
              runId: assignment.runId,
              fetchImpl,
              status: {
                phase: 'failed',
                exitCode: 1,
                durationMs: Date.now() - startedAt,
                error: toShortError(error),
                summary: 'Worker assignment failed.',
              },
            }).catch((statusError) => {
              options.log?.(`Failed to report assignment failure: ${toShortError(statusError)}`);
            });
            options.log?.(`Assignment ${assignment.runId} failed: ${toShortError(error)}`);
          }

          if (options.once) {
            return;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        options.log?.(`Worker queue disconnected: ${toShortError(error)}`);
        await sleep(QUEUE_RECONNECT_MS);
      }
    }
  } finally {
    stopped = true;
    heartbeatAbort.abort();
    wakeHeartbeat?.();
    await heartbeatPromise.catch(() => undefined);
  }
}
