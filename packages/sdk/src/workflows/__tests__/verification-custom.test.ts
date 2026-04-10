import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowDb } from '../runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../types.js';

const mockRelaycastAgent = {
  send: vi.fn().mockResolvedValue(undefined),
  heartbeat: vi.fn().mockResolvedValue(undefined),
  channels: {
    create: vi.fn().mockResolvedValue(undefined),
    join: vi.fn().mockResolvedValue(undefined),
    invite: vi.fn().mockResolvedValue(undefined),
  },
};

const mockRelaycast = {
  agents: {
    register: vi.fn().mockResolvedValue({ token: 'token-1' }),
  },
  as: vi.fn().mockReturnValue(mockRelaycastAgent),
};

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => mockRelaycast),
  RelayError: class RelayError extends Error {},
}));

const mockHuman = {
  name: 'WorkflowRunner',
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

const mockRelayInstance = {
  spawnPty: vi.fn(),
  human: vi.fn().mockReturnValue(mockHuman),
  shutdown: vi.fn().mockResolvedValue(undefined),
  onBrokerStderr: vi.fn().mockReturnValue(() => {}),
  listAgentsRaw: vi.fn().mockResolvedValue([]),
  onWorkerOutput: null as ((frame: { name: string; chunk: string }) => void) | null,
  onMessageReceived: null as any,
  onAgentSpawned: null as any,
  onAgentReleased: null as any,
  onAgentExited: null as any,
  onAgentIdle: null as any,
  onDeliveryUpdate: null as any,
};

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

type QueuedSubprocessResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  error?: Error;
  beforeClose?: () => void;
};

let queuedSubprocessResults: QueuedSubprocessResult[] = [];

const mockSubprocessSpawn = vi.fn().mockImplementation((_cmd, _args, _options) => {
  const result = queuedSubprocessResults.shift() ?? { stdout: 'done\n', code: 0 };
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (result.error) {
      child.emit('error', result.error);
      return;
    }
    if (result.stdout) {
      child.stdout.emit('data', Buffer.from(result.stdout));
    }
    if (result.stderr) {
      child.stderr.emit('data', Buffer.from(result.stderr));
    }
    result.beforeClose?.();
    child.emit('close', result.code ?? 0, result.signal ?? null);
  });

  return child;
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: mockSubprocessSpawn,
  };
});

const { WorkflowRunner } = await import('../runner.js');
const { runVerification } = await import('../verification.js');

const noopSideEffects = {
  recordStepToolSideEffect: vi.fn(),
  getOrCreateStepEvidenceRecord: vi.fn(() => ({
    evidence: { coordinationSignals: [] },
  })),
  log: vi.fn(),
};

const tempDirs: string[] = [];

function run(check: Parameters<typeof runVerification>[0], output = 'worker output', cwd?: string) {
  return runVerification(
    check,
    output,
    'custom-step',
    undefined,
    { allowFailure: true, cwd },
    noopSideEffects
  );
}

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    insertRun: vi.fn(async (runRow: WorkflowRunRow) => {
      runs.set(runRow.id, { ...runRow });
    }),
    updateRun: vi.fn(async (id: string, patch: Partial<WorkflowRunRow>) => {
      const existing = runs.get(id);
      if (existing) runs.set(id, { ...existing, ...patch });
    }),
    getRun: vi.fn(async (id: string) => {
      const runRow = runs.get(id);
      return runRow ? { ...runRow } : null;
    }),
    insertStep: vi.fn(async (stepRow: WorkflowStepRow) => {
      steps.set(stepRow.id, { ...stepRow });
    }),
    updateStep: vi.fn(async (id: string, patch: Partial<WorkflowStepRow>) => {
      const existing = steps.get(id);
      if (existing) steps.set(id, { ...existing, ...patch });
    }),
    getStepsByRunId: vi.fn(async (runId: string) => {
      return [...steps.values()].filter((stepRow) => stepRow.runId === runId);
    }),
  };
}

function makeConfig(projectDir: string, verificationValue: string): RelayYamlConfig {
  return {
    version: '1',
    name: 'verification-custom',
    swarm: { pattern: 'dag' },
    errorHandling: {
      strategy: 'retry',
      retryDelayMs: 0,
    },
    agents: [{ name: 'worker', cli: 'claude', interactive: false }],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'custom-step',
            agent: 'worker',
            task: 'Implement the requested change',
            retries: 1,
            cwd: projectDir,
            verification: {
              type: 'custom',
              value: verificationValue,
            },
          },
        ],
      },
    ],
    trajectories: false,
  };
}

describe('custom verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queuedSubprocessResults = [];
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('custom verification with command that exits 0 passes', () => {
    const result = run({ type: 'custom', value: 'echo ok' });

    expect(result.passed).toBe(true);
    expect(result.completionReason).toBe('completed_verified');
  });

  it('custom verification with command that exits non-zero fails', () => {
    const result = run({ type: 'custom', value: 'exit 1' });

    expect(result.passed).toBe(false);
    expect(result.completionReason).toBe('failed_verification');
    expect(result.error).toContain('custom check "exit 1" failed');
    expect(result.error).toContain('Command failed: exit 1');
  });

  it('custom verification captures stderr in failure message', () => {
    const result = run({
      type: 'custom',
      value: "echo 'compile error: missing semicolon' >&2; exit 1",
    });

    expect(result.passed).toBe(false);
    expect(result.error).toContain('compile error: missing semicolon');
  });

  it('custom verification with no value preserves legacy no-op', () => {
    const result = run({ type: 'custom', value: '' });

    expect(result).toEqual({ passed: false });
  });

  it('custom verification respects cwd', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'verification-custom-cwd-'));
    tempDirs.push(tempDir);
    writeFileSync(path.join(tempDir, 'myfile.txt'), 'present');

    const result = run({ type: 'custom', value: 'test -f myfile.txt' }, 'worker output', tempDir);

    expect(result.passed).toBe(true);
    expect(result.completionReason).toBe('completed_verified');
  });

  it('custom verification timeout kills long-running command', () => {
    const result = run({ type: 'custom', value: 'sleep 60', timeoutMs: 1000 });

    expect(result.passed).toBe(false);
    expect(result.completionReason).toBe('failed_verification');
    expect(result.error).toContain('sleep 60');
    expect(result.error).toMatch(/ETIMEDOUT|timed out/i);
  });

  it('verification failure output appears in retry prompt', async () => {
    const projectDir = mkdtempSync(path.join(os.tmpdir(), 'verification-custom-runner-'));
    tempDirs.push(projectDir);

    const verificationValue =
      `sh -c 'if [ -f ready.txt ]; then exit 0; ` +
      `else echo "compile error: missing semicolon" >&2; exit 1; fi'`;

    queuedSubprocessResults = [
      {
        stdout: 'first attempt\n',
        code: 0,
      },
      {
        stdout: 'second attempt\n',
        code: 0,
        beforeClose: () => {
          writeFileSync(path.join(projectDir, 'ready.txt'), 'ok');
        },
      },
    ];

    const runner = new WorkflowRunner({
      cwd: projectDir,
      db: makeDb(),
      workspaceId: 'ws-test',
    });

    const result = await runner.execute(makeConfig(projectDir, verificationValue), 'default');

    expect(result.status, result.error).toBe('completed');
    expect(mockSubprocessSpawn).toHaveBeenCalledTimes(2);

    const retryArgs = mockSubprocessSpawn.mock.calls[1]?.[1] as string[] | undefined;
    const retryPrompt = retryArgs?.find((arg) => arg.includes('[RETRY')) ?? retryArgs?.join('\n') ?? '';

    expect(retryPrompt).toContain('[VERIFICATION FAILED]');
    expect(retryPrompt).toContain(`Command: ${verificationValue}`);
    expect(retryPrompt).toContain('compile error: missing semicolon');
    expect(retryPrompt).toContain('Fix the issues above before proceeding.');
  });
});
