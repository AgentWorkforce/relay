import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cloudWorkerStorePath,
  readCloudWorkerStore,
  registerCloudWorker,
  runCloudWorkerLoop,
  streamCloudWorkerQueue,
  type CloudWorkerRecord,
  type WorkAssignmentRecord,
  type WorkerWorkflowPayload,
} from './worker.js';

let tmpHome: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-worker-test-'));
  env = { ...process.env, AGENT_RELAY_HOME: tmpHome };
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream',
      },
    }
  );
}

function assignment(payload: WorkerWorkflowPayload, overrides: Partial<WorkAssignmentRecord> = {}): WorkAssignmentRecord {
  return {
    id: 'asn_1',
    workspaceId: payload.workspaceId,
    workerId: 'wrk_1',
    runId: payload.runId,
    workflowRef: {
      type: 'inline',
      value: JSON.stringify(payload),
    },
    status: 'assigned',
    queuedAt: '2026-06-13T00:00:00.000Z',
    assignedAt: '2026-06-13T00:00:01.000Z',
    startedAt: null,
    completedAt: null,
    queueDeadline: '2026-06-13T00:10:00.000Z',
    ...overrides,
  };
}

const payload: WorkerWorkflowPayload = {
  runId: 'run_1',
  workspaceId: 'rw_1',
  relayWorkspaceId: 'rw_relay',
  relaycastApiKey: 'rk_live_test',
  relayfileUrl: 'https://relayfile.test',
  relayfileToken: 'relay_token_secret',
  workflow: 'version: "1.0"\nworkflows: []\n',
  fileType: 'yaml',
  sourceFileType: 'yaml',
  workflowFileName: 'workflow.yaml',
};

describe('cloud worker store and API client', () => {
  it('registers a worker and stores only the returned worker token', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(url)).toBe('https://cloud.test/api/v1/workers/register');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        enrollmentToken: 'ocl_wrk_enr_secret',
        name: 'demo-worker',
      });
      return jsonResponse({
        workerId: 'wrk_1',
        workerToken: 'ocl_wrk_secret',
        heartbeatIntervalMs: 30_000,
      });
    }) as unknown as typeof fetch;

    const record = await registerCloudWorker({
      enrollmentToken: 'ocl_wrk_enr_secret',
      name: 'demo-worker',
      baseUrl: 'https://cloud.test',
      env,
      fetchImpl,
    });

    expect(record).toMatchObject({
      baseUrl: 'https://cloud.test',
      workerId: 'wrk_1',
      workerToken: 'ocl_wrk_secret',
      name: 'demo-worker',
    });

    const storeRaw = fs.readFileSync(cloudWorkerStorePath(env), 'utf-8');
    expect(storeRaw).toContain('ocl_wrk_secret');
    expect(storeRaw).not.toContain('ocl_wrk_enr_secret');
    expect(readCloudWorkerStore(env).active?.['https://cloud.test']).toBe('https://cloud.test#wrk_1');
    expect((fs.statSync(cloudWorkerStorePath(env)).mode & 0o777).toString(8)).toBe('600');
  });

  it('parses worker queue SSE events', async () => {
    const worker: CloudWorkerRecord = {
      baseUrl: 'https://cloud.test',
      workerId: 'wrk_1',
      workerToken: 'ocl_wrk_secret',
      name: 'demo-worker',
      heartbeatIntervalMs: 30_000,
      registeredAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    };
    const asn = assignment(payload);
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'event: ping\ndata: {}\n\n',
        `event: assignment\ndata: ${JSON.stringify(asn)}\n\n`,
        'event: revoke\ndata: {}\n\n',
      ])
    ) as unknown as typeof fetch;

    const events = [];
    for await (const event of streamCloudWorkerQueue({ worker, fetchImpl })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['ping', 'assignment', 'revoke']);
    expect(events[1]).toMatchObject({ type: 'assignment', assignment: { runId: 'run_1' } });
  });

  it('runs the worker control loop with ack, running, completed, duplicate suppression, and revoke', async () => {
    const worker: CloudWorkerRecord = {
      baseUrl: 'https://cloud.test',
      workerId: 'wrk_1',
      workerToken: 'ocl_wrk_secret',
      name: 'demo-worker',
      heartbeatIntervalMs: 60_000,
      registeredAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    };
    const asn = assignment(payload);
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const requestUrl = String(url);
      const method = init?.method ?? 'GET';
      requests.push({
        url: requestUrl,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      });

      if (requestUrl.endsWith('/heartbeat')) {
        return jsonResponse({ ok: true, nextHeartbeatMs: 60_000 });
      }
      if (requestUrl.endsWith('/queue')) {
        return sseResponse([
          `event: assignment\ndata: ${JSON.stringify(asn)}\n\n`,
          `event: assignment\ndata: ${JSON.stringify(asn)}\n\n`,
          'event: revoke\ndata: {}\n\n',
        ]);
      }
      if (requestUrl.endsWith('/ack')) {
        return jsonResponse({ ok: true, status: 'assigned' });
      }
      if (requestUrl.endsWith('/status')) {
        return jsonResponse({ ok: true, status: 'running' });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    }) as unknown as typeof fetch;
    const executeAssignment = vi.fn(async () => ({
      exitCode: 0,
      durationMs: 15,
      summary: 'done',
    }));

    await runCloudWorkerLoop({
      worker,
      fetchImpl,
      executeAssignment,
      log: () => undefined,
    });

    expect(executeAssignment).toHaveBeenCalledTimes(1);
    expect(requests.filter((request) => request.url.endsWith('/ack'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/status')).map((request) => request.body)).toEqual([
      { phase: 'running' },
      { phase: 'completed', exitCode: 0, durationMs: 15, summary: 'done' },
    ]);
  });

  it('logs timeout events and reconnects a dropped queue stream', async () => {
    const worker: CloudWorkerRecord = {
      baseUrl: 'https://cloud.test',
      workerId: 'wrk_1',
      workerToken: 'ocl_wrk_secret',
      name: 'demo-worker',
      heartbeatIntervalMs: 60_000,
      registeredAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    };
    const timedOut = assignment({ ...payload, runId: 'run_timeout' }, { runId: 'run_timeout' });
    const logs: string[] = [];
    let queueAttempts = 0;
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/heartbeat')) {
        return jsonResponse({ ok: true, nextHeartbeatMs: 60_000 });
      }
      if (requestUrl.endsWith('/queue')) {
        queueAttempts += 1;
        if (queueAttempts === 1) {
          return jsonResponse({ error: 'temporary' }, { status: 503 });
        }
        return sseResponse([
          `event: timeout\ndata: ${JSON.stringify(timedOut)}\n\n`,
          'event: revoke\ndata: {}\n\n',
        ]);
      }
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await runCloudWorkerLoop({
      worker,
      fetchImpl,
      executeAssignment: vi.fn(),
      log: (message) => logs.push(message),
      sleep: async () => undefined,
    });

    expect(queueAttempts).toBe(2);
    expect(logs).toContain('Worker queue disconnected: temporary');
    expect(logs).toContain('Assignment run_timeout timed out before execution.');
    expect(logs).toContain('Worker was revoked by Cloud; stopping.');
  });
});
