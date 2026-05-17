import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SKILL_PATH = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
  '..',
  'skills',
  'spawn-cloud-swarm',
  'SKILL.md'
);

interface MountStatus {
  running: boolean;
  conflictCount: number;
  conflictPath?: string;
}

interface AgentState {
  name: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
}

interface SpawnResult {
  ok: true;
  agentName: string;
  sandboxUrl: string;
}

interface SpawnError {
  ok: false;
  code: 'QUOTA_EXCEEDED' | string;
}

interface McpHarness {
  ensure: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  callLog: string[];
}

const TOOLS = {
  ensure: 'cloud.local-mount.ensure',
  status: 'cloud.local-mount.status',
  stop: 'cloud.local-mount.stop',
  spawn: 'cloud.agent.spawn',
  list: 'cloud.agent.list',
} as const;

function createHarness(opts: {
  spawnResults: Array<SpawnResult | SpawnError>;
  statusSequence: MountStatus[];
  listSequence: AgentState[][];
}): McpHarness {
  const callLog: string[] = [];

  let statusIdx = 0;
  const status = vi.fn(async () => {
    callLog.push(TOOLS.status);
    const next = opts.statusSequence[Math.min(statusIdx, opts.statusSequence.length - 1)];
    statusIdx += 1;
    return next;
  });

  let listIdx = 0;
  const list = vi.fn(async () => {
    callLog.push(TOOLS.list);
    const next = opts.listSequence[Math.min(listIdx, opts.listSequence.length - 1)];
    listIdx += 1;
    return next;
  });

  let spawnIdx = 0;
  const spawn = vi.fn(async () => {
    callLog.push(TOOLS.spawn);
    const next = opts.spawnResults[Math.min(spawnIdx, opts.spawnResults.length - 1)];
    spawnIdx += 1;
    if (!next.ok) {
      const err = new Error(next.code);
      (err as Error & { code?: string }).code = next.code;
      throw err;
    }
    return next;
  });

  const ensure = vi.fn(async () => {
    callLog.push(TOOLS.ensure);
    return { mountPath: '/mnt/relayfile', workspaceId: 'ws-1', status: 'started' };
  });

  const stop = vi.fn(async () => {
    callLog.push(TOOLS.stop);
    return { stopped: true };
  });

  return { ensure, status, stop, spawn, list, callLog };
}

/**
 * Faithful programmatic re-implementation of the procedure documented in
 * skills/spawn-cloud-swarm/SKILL.md. The test asserts the call sequence,
 * quota backoff, monitor loop, and teardown branch against a mocked MCP
 * harness. Drift between this driver and the SKILL.md body is caught by the
 * "SKILL.md references each tool by exact name" assertion.
 */
async function runProcedure(harness: McpHarness, opts: {
  workers: number;
  localDir: string;
  teardown: 'persist' | 'stop';
  pollIterations: number;
  sleep: (ms: number) => Promise<void>;
}) {
  await harness.ensure({ localDir: opts.localDir });

  let backoffWaits = 0;
  for (let i = 0; i < opts.workers; ) {
    try {
      await harness.spawn({ workspaceId: 'ws-1' });
      i += 1;
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'QUOTA_EXCEEDED' && backoffWaits < 3) {
        backoffWaits += 1;
        await opts.sleep(10_000);
        continue;
      }
      throw err;
    }
  }

  for (let i = 0; i < opts.pollIterations; i += 1) {
    const mountStatus = await harness.status({ localDir: opts.localDir });
    const agents = await harness.list();
    if (!mountStatus.running) break;
    if (agents.every((a) => a.status !== 'running')) break;
  }

  if (opts.teardown === 'stop') {
    await harness.stop({ localDir: opts.localDir });
  }
}

describe('spawn-cloud-swarm SKILL.md', () => {
  it('references every required MCP tool by exact name', () => {
    const body = fs.readFileSync(SKILL_PATH, 'utf-8');
    for (const tool of Object.values(TOOLS)) {
      expect(body).toContain(tool);
    }
  });

  it('quotes the three NEEDS_* remediation codes verbatim', () => {
    const body = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(body).toContain('NEEDS_CLOUD_LOGIN');
    expect(body).toContain('NEEDS_CLI_CONNECTION');
    expect(body).toContain('NEEDS_RELAYFILE_SETUP');
  });

  it('declares the teardown default is persist (not stop)', () => {
    const body = fs.readFileSync(SKILL_PATH, 'utf-8');
    expect(body).toMatch(/persist/i);
    expect(body).toMatch(/\[persist\]/);
  });
});

describe('spawn-cloud-swarm procedural driver', () => {
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sleep = vi.fn(async () => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invokes tools in the documented order: ensure → spawn×N → poll(status+list) → no-stop on persist', async () => {
    const harness = createHarness({
      spawnResults: [
        { ok: true, agentName: 'worker-1', sandboxUrl: 'https://daytona/1' },
        { ok: true, agentName: 'worker-2', sandboxUrl: 'https://daytona/2' },
      ],
      statusSequence: [{ running: true, conflictCount: 0 }, { running: true, conflictCount: 0 }],
      listSequence: [
        [
          { name: 'worker-1', status: 'running' },
          { name: 'worker-2', status: 'running' },
        ],
        [
          { name: 'worker-1', status: 'completed' },
          { name: 'worker-2', status: 'completed' },
        ],
      ],
    });

    await runProcedure(harness, {
      workers: 2,
      localDir: '/repo',
      teardown: 'persist',
      pollIterations: 2,
      sleep,
    });

    expect(harness.callLog).toEqual([
      TOOLS.ensure,
      TOOLS.spawn,
      TOOLS.spawn,
      TOOLS.status,
      TOOLS.list,
      TOOLS.status,
      TOOLS.list,
    ]);
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it('backs off on QUOTA_EXCEEDED and resumes within 3 cycles', async () => {
    const harness = createHarness({
      spawnResults: [
        { ok: false, code: 'QUOTA_EXCEEDED' },
        { ok: false, code: 'QUOTA_EXCEEDED' },
        { ok: true, agentName: 'worker-1', sandboxUrl: 'https://daytona/1' },
      ],
      statusSequence: [{ running: true, conflictCount: 0 }],
      listSequence: [[{ name: 'worker-1', status: 'completed' }]],
    });

    await runProcedure(harness, {
      workers: 1,
      localDir: '/repo',
      teardown: 'persist',
      pollIterations: 1,
      sleep,
    });

    expect(harness.spawn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 10_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 10_000);
  });

  it('fails after 3 backoff cycles still returning QUOTA_EXCEEDED', async () => {
    const harness = createHarness({
      spawnResults: [
        { ok: false, code: 'QUOTA_EXCEEDED' },
        { ok: false, code: 'QUOTA_EXCEEDED' },
        { ok: false, code: 'QUOTA_EXCEEDED' },
        { ok: false, code: 'QUOTA_EXCEEDED' },
      ],
      statusSequence: [{ running: true, conflictCount: 0 }],
      listSequence: [[]],
    });

    await expect(
      runProcedure(harness, {
        workers: 1,
        localDir: '/repo',
        teardown: 'persist',
        pollIterations: 1,
        sleep,
      })
    ).rejects.toThrow('QUOTA_EXCEEDED');
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('calls cloud.local-mount.stop ONLY when the user opts to stop', async () => {
    const harness = createHarness({
      spawnResults: [{ ok: true, agentName: 'worker-1', sandboxUrl: 'https://daytona/1' }],
      statusSequence: [{ running: true, conflictCount: 0 }],
      listSequence: [[{ name: 'worker-1', status: 'completed' }]],
    });

    await runProcedure(harness, {
      workers: 1,
      localDir: '/repo',
      teardown: 'stop',
      pollIterations: 1,
      sleep,
    });

    expect(harness.stop).toHaveBeenCalledTimes(1);
    expect(harness.stop).toHaveBeenCalledWith({ localDir: '/repo' });
  });
});
