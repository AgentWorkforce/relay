import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertCloudWorkerRecord, type WorkerWorkflowPayload } from '@agent-relay/cloud';
import {
  createDefaultAssignmentRunner,
  registerCloudWorkerCommands,
  type CloudWorkerDependencies,
} from './cloud-worker.js';

const directories: string[] = [];
const worker = {
  baseUrl: 'https://control.example.test',
  workerId: 'fixture-worker',
  workerToken: 'fixture-worker-token',
  name: 'fixture',
  heartbeatIntervalMs: 1,
  registeredAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const payload: WorkerWorkflowPayload = {
  runId: 'fixture-run',
  workspaceId: 'fixture-workspace',
  relayWorkspaceId: 'fixture-relay',
  relaycastApiKey: 'fixture-relaycast-token',
  relayfileUrl: 'https://files.example.test',
  relayfileToken: 'fixture-run-scoped-file-token',
  workflow: 'version: "0.1.0"\nname: fixture\nsteps: []\n',
  fileType: 'yaml',
  sourceFileType: 'yaml',
  workflowFileName: 'workflow.yaml',
};

function harness(exitCode = 0) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-local-agent-'));
  directories.push(home);
  const statuses: Array<{ phase: string }> = [];
  const spawnProcess = vi.fn((..._args: unknown[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      kill: vi.fn(),
      unref: vi.fn(),
    });
    queueMicrotask(() => child.emit('exit', exitCode, null));
    return child;
  });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe(worker.baseUrl);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + worker.workerToken);
    if (url.pathname.endsWith('/heartbeat')) return Response.json({ nextHeartbeatMs: 1 });
    if (url.pathname.endsWith('/queue')) {
      const assignment = {
        id: 'fixture-assignment',
        runId: payload.runId,
        workflowRef: { type: 'inline', value: JSON.stringify(payload) },
      };
      return new Response(`event: assignment\ndata: ${JSON.stringify(assignment)}\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    if (url.pathname.endsWith('/ack')) return Response.json({ ok: true });
    if (url.pathname.endsWith('/status')) {
      statuses.push(JSON.parse(String(init?.body)) as { phase: string });
      return Response.json({ ok: true });
    }
    throw new Error('unexpected_fixture_request');
  });
  const deps: CloudWorkerDependencies & { stdin: Readable } = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as never,
    env: { AGENT_RELAY_HOME: home },
    spawnProcess: spawnProcess as never,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    cwd: () => home,
    fetchImpl,
    resolveAgentRelayCliEntrypoint: () => '/opt/relay/dist/cli/index.js',
    stdin: Readable.from([]),
  };
  upsertCloudWorkerRecord(worker, deps.env);
  const program = new Command().exitOverride();
  registerCloudWorkerCommands(program.command('cloud'), deps);
  return { program, deps, spawnProcess, fetchImpl, statuses };
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('cloud worker local execution opt-in', () => {
  it.each([false, true])(
    'threads localAgent=%s through the real queue loop and assignment runner',
    async (localAgent) => {
      const h = harness();
      await h.program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'start',
        '--once',
        '--base-url',
        worker.baseUrl,
        ...(localAgent ? ['--local-agent'] : []),
      ]);
      expect(h.spawnProcess).toHaveBeenCalledOnce();
      const [command, args, options] = h.spawnProcess.mock.calls[0]!;
      expect(command).toBe(process.execPath);
      expect(args).toEqual([
        '/opt/relay/dist/cli/index.js',
        'flows',
        'run',
        path.join(h.deps.env.AGENT_RELAY_HOME!, 'cloud-workers', 'runs', payload.runId, 'workflow.yaml'),
        ...(localAgent ? ['--local-agent'] : []),
      ]);
      expect(options).toEqual(
        expect.objectContaining({ env: expect.objectContaining({ RELAYFILE_TOKEN: payload.relayfileToken }) })
      );
      expect(h.statuses.map((s) => s.phase)).toEqual(['running', 'completed']);
      expect(h.fetchImpl.mock.calls.every(([input]) => !String(input).includes('/register'))).toBe(true);
    }
  );

  it.each([false, true])(
    'reports a parked/refused child as failed, never completed (localAgent=%s)',
    async (localAgent) => {
      const h = harness(3); // SDK's worker_unavailable/parked run exit code.
      await h.program.parseAsync([
        'node',
        'relay',
        'cloud',
        'worker',
        'start',
        '--once',
        '--base-url',
        worker.baseUrl,
        ...(localAgent ? ['--local-agent'] : []),
      ]);
      expect(h.statuses.map((s) => s.phase)).toEqual(['running', 'failed']);
      expect(h.deps.log).not.toHaveBeenCalledWith(expect.stringContaining(' completed.'));
    }
  );

  it.each([false, true])('retains localAgent=%s through daemon re-entry', async (localAgent) => {
    const h = harness();
    await h.program.parseAsync([
      'node',
      'relay',
      'cloud',
      'worker',
      'start',
      '--daemon',
      '--once',
      '--base-url',
      worker.baseUrl,
      ...(localAgent ? ['--local-agent'] : []),
    ]);
    expect(h.spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [
        '/opt/relay/dist/cli/index.js',
        'cloud',
        'worker',
        'start',
        '--worker-id',
        worker.workerId,
        '--base-url',
        worker.baseUrl,
        '--foreground-child',
        '--once',
        ...(localAgent ? ['--local-agent'] : []),
      ],
      expect.objectContaining({ detached: true })
    );
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps state-bearing assignment refusal before spawning with local execution selected', async () => {
    const h = harness();
    const runner = createDefaultAssignmentRunner(h.deps, { localAgent: true });
    await expect(
      runner({
        assignment: { runId: payload.runId } as never,
        payload: { ...payload, resumeRunId: 'previous' },
        worker,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('state-bearing');
    expect(h.spawnProcess).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});
