import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BudgetTracker } from '../budget-tracker.js';
import type { CliSessionQuery, CliSessionReport } from '../cli-session-collector.js';
import type { WorkflowDb } from '../runner.js';
import type { AgentDefinition, RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../types.js';

type WorkflowConfigStep = NonNullable<RelayYamlConfig['workflows']>[number]['steps'][number];

const tempDirs: string[] = [];

type QueuedSubprocessResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  delayMs?: number;
  error?: Error;
  beforeClose?: () => void;
};

type CollectorResult =
  | CliSessionReport
  | null
  | ((query: CliSessionQuery) => CliSessionReport | null | Promise<CliSessionReport | null>);

let queuedSubprocessResults: QueuedSubprocessResult[] = [];
let queuedCollectorResults: CollectorResult[] = [];

const mockCollectCliSession = vi.fn(async (query: CliSessionQuery): Promise<CliSessionReport | null> => {
  const next = queuedCollectorResults.shift();
  if (typeof next === 'function') {
    return next(query);
  }
  return next ?? null;
});

vi.mock('../cli-session-collector.js', () => ({
  collectCliSession: mockCollectCliSession,
}));

const mockSubprocessSpawn = vi.fn().mockImplementation((_cmd, _args, _options) => {
  const result = queuedSubprocessResults.shift() ?? {
    stdout: 'completed\n',
    code: 0,
  };

  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;

  let closed = false;
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  const clearPending = () => {
    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = undefined;
    }
  };
  const closeChild = (code: number | null = result.code ?? 0, signal: string | null = result.signal ?? null) => {
    if (closed) return;
    closed = true;
    clearPending();
    child.emit('close', code, signal);
  };

  child.kill = vi.fn((signal?: string | number) => {
    clearPending();
    queueMicrotask(() => closeChild(null, typeof signal === 'string' ? signal : null));
    return true;
  });

  const emitResult = () => {
    if (closed) return;
    if (result.error) {
      closed = true;
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
    closeChild(result.code ?? 0, result.signal ?? null);
  };

  if (result.delayMs && result.delayMs > 0) {
    delayTimer = setTimeout(emitResult, result.delayMs);
  } else {
    queueMicrotask(emitResult);
  }

  return child;
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: mockSubprocessSpawn,
  };
});

const mockHuman = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

const mockRelayInstance = {
  spawnPty: vi.fn(),
  human: vi.fn().mockReturnValue(mockHuman),
  shutdown: vi.fn().mockResolvedValue(undefined),
  onBrokerStderr: vi.fn().mockReturnValue(() => {}),
  listAgentsRaw: vi.fn().mockResolvedValue([]),
  listAgents: vi.fn().mockResolvedValue([]),
  onWorkerOutput: null as ((frame: { name: string; chunk: string }) => void) | null,
  onMessageReceived: null as any,
  onAgentSpawned: null as any,
  onAgentReleased: null as any,
  onAgentExited: null as any,
  onAgentIdle: null as any,
  onDeliveryUpdate: null as any,
};

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

const { workflow } = await import('../builder.js');
const { WorkflowRunner } = await import('../runner.js');

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    insertRun: vi.fn(async (runRow: WorkflowRunRow) => {
      runs.set(runRow.id, { ...runRow });
    }),
    updateRun: vi.fn(async (id: string, patch: Partial<WorkflowRunRow>) => {
      const existing = runs.get(id);
      if (existing) {
        runs.set(id, { ...existing, ...patch });
      }
    }),
    getRun: vi.fn(async (id: string) => {
      const run = runs.get(id);
      return run ? { ...run } : null;
    }),
    insertStep: vi.fn(async (stepRow: WorkflowStepRow) => {
      steps.set(stepRow.id, { ...stepRow });
    }),
    updateStep: vi.fn(async (id: string, patch: Partial<WorkflowStepRow>) => {
      const existing = steps.get(id);
      if (existing) {
        steps.set(id, { ...existing, ...patch });
      }
    }),
    getStepsByRunId: vi.fn(async (runId: string) => {
      return [...steps.values()].filter((step) => step.runId === runId).map((step) => ({ ...step }));
    }),
  };
}

function createWorkspace(subdirs: string[] = []): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-verification-traceback-'));
  tempDirs.push(dir);
  for (const subdir of subdirs) {
    mkdirSync(path.join(dir, subdir), { recursive: true });
  }
  return dir;
}

function makeRunner(cwd: string): InstanceType<typeof WorkflowRunner> {
  return new WorkflowRunner({
    cwd,
    db: makeDb(),
    workspaceId: 'ws-test',
    relay: {
      env: {
        AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1',
      },
    },
  });
}

function makeReport(
  tokens: Partial<NonNullable<CliSessionReport['tokens']>>,
  overrides: Partial<CliSessionReport> = {}
): CliSessionReport {
  return {
    cli: 'claude',
    sessionId: 'session-1',
    model: 'claude-sonnet-4',
    provider: 'anthropic',
    durationMs: 1_000,
    cost: null,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      cacheRead: tokens.cacheRead ?? 0,
    },
    turns: 1,
    toolCalls: [],
    errors: [],
    finalStatus: 'completed',
    summary: 'done',
    ...overrides,
  };
}

function makeConfig(input: {
  workspace: string;
  verification: WorkflowConfigStep['verification'];
  retries?: number;
  swarm?: Partial<RelayYamlConfig['swarm']>;
  includeDiagnosticAgent?: boolean;
}): RelayYamlConfig {
  const workerCwd = path.join(input.workspace, 'worker');
  const diagCwd = path.join(input.workspace, 'diag');

  return {
    version: '1',
    name: 'verification-traceback',
    swarm: {
      pattern: 'dag',
      ...input.swarm,
    },
    errorHandling: {
      strategy: 'retry',
      retryDelayMs: 0,
    },
    agents: [
      {
        name: 'worker',
        cli: 'claude',
        interactive: false,
        cwd: workerCwd,
      },
      ...(input.includeDiagnosticAgent === false
        ? []
        : [
            {
              name: 'diag',
              cli: 'claude',
              interactive: false,
              cwd: diagCwd,
            } satisfies AgentDefinition,
          ]),
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'implement',
            agent: 'worker',
            task: 'Implement the requested change',
            retries: input.retries ?? 1,
            verification: input.verification,
          },
        ],
      },
    ],
    trajectories: false,
  };
}

function verificationCommand(): string {
  return (
    `sh -c 'if [ -f ready.txt ]; then exit 0; ` +
    `else echo "compile error: missing semicolon" >&2; exit 1; fi'`
  );
}

function taskFromExecCall(
  execSpy: ReturnType<typeof vi.spyOn>,
  callIndex: number
): string {
  const call = execSpy.mock.calls[callIndex] as [AgentDefinition, { task?: string }] | undefined;
  return String(call?.[1]?.task ?? '');
}

function getBudgetTracker(runner: InstanceType<typeof WorkflowRunner>): BudgetTracker | undefined {
  return (runner as any).budgetTracker as BudgetTracker | undefined;
}

describe('verification traceback retry handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queuedSubprocessResults = [];
    queuedCollectorResults = [];
    mockRelayInstance.shutdown.mockResolvedValue(undefined);
    mockRelayInstance.onBrokerStderr.mockReturnValue(() => {});
    mockRelayInstance.listAgents.mockResolvedValue([]);
    mockRelayInstance.listAgentsRaw.mockResolvedValue([]);
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('verification failure without diagnosticAgent uses standard retry', async () => {
    const workspace = createWorkspace(['worker']);
    const runner = makeRunner(workspace);
    const execSpy = vi.spyOn(runner as any, 'execNonInteractive');

    queuedSubprocessResults = [
      { stdout: 'first attempt\n', code: 0 },
      {
        stdout: 'second attempt\n',
        code: 0,
        beforeClose: () => {
          writeFileSync(path.join(workspace, 'ready.txt'), 'ok');
        },
      },
    ];

    const result = await runner.execute(
      makeConfig({
        workspace,
        includeDiagnosticAgent: false,
        verification: {
          type: 'custom',
          value: verificationCommand(),
        },
      }),
      'default'
    );

    expect(result.status, result.error).toBe('completed');
    expect(execSpy).toHaveBeenCalledTimes(2);

    const retryTask = taskFromExecCall(execSpy, 1);
    expect(retryTask).toContain('[VERIFICATION FAILED]');
    expect(retryTask).toContain(`Command: ${verificationCommand()}`);
    expect(retryTask).toContain('compile error: missing semicolon');
    expect(retryTask).not.toContain('Diagnostic analysis:');
  });

  it('verification failure with diagnosticAgent runs diagnostic before retry', async () => {
    const workspace = createWorkspace(['worker', 'diag']);
    const runner = makeRunner(workspace);
    const execSpy = vi.spyOn(runner as any, 'execNonInteractive');

    queuedSubprocessResults = [
      { stdout: 'first attempt\n', code: 0 },
      { stdout: 'The issue is in file X, line Y: missing semicolon\n', code: 0 },
      { stdout: 'second attempt\n', code: 0 },
    ];

    const result = await runner.execute(
      makeConfig({
        workspace,
        verification: {
          type: 'custom',
          value: 'exit 1',
          diagnosticAgent: 'diag',
        },
      }),
      'default'
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Step "implement" failed after 1 retries');

    expect(execSpy).toHaveBeenCalledTimes(3);

    const diagnosticCall = execSpy.mock.calls[1] as [AgentDefinition, { task?: string }];
    expect(diagnosticCall[0].name).toBe('diag');
    expect(String(diagnosticCall[1].task)).toContain('Analyze what went wrong. Be specific. Do NOT fix the code.');

    const retryTask = taskFromExecCall(execSpy, 2);
    expect(retryTask).toContain('Diagnostic analysis:');
    expect(retryTask).toContain('The issue is in file X, line Y: missing semicolon');
  });

  it('diagnostic agent timeout falls back to standard retry', async () => {
    const workspace = createWorkspace(['worker', 'diag']);
    const runner = makeRunner(workspace);
    const execSpy = vi.spyOn(runner as any, 'execNonInteractive');
    const logSpy = vi.spyOn(runner as any, 'log').mockImplementation(() => {});

    queuedSubprocessResults = [
      { stdout: 'first attempt\n', code: 0 },
      { stdout: 'slow diagnostic\n', code: 0, delayMs: 5_000 },
      {
        stdout: 'second attempt\n',
        code: 0,
        beforeClose: () => {
          writeFileSync(path.join(workspace, 'ready.txt'), 'ok');
        },
      },
    ];

    const result = await runner.execute(
      makeConfig({
        workspace,
        verification: {
          type: 'custom',
          value: verificationCommand(),
          diagnosticAgent: 'diag',
          diagnosticTimeout: 100,
        },
      }),
      'default'
    );

    expect(result.status, result.error).toBe('completed');
    expect(execSpy).toHaveBeenCalledTimes(3);

    const retryTask = taskFromExecCall(execSpy, 2);
    expect(retryTask).toContain('[VERIFICATION FAILED]');
    expect(retryTask).toContain('compile error: missing semicolon');
    expect(retryTask).not.toContain('Diagnostic analysis:');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Diagnostic timed out'));
  });

  it('diagnostic agent failure falls back to standard retry', async () => {
    const workspace = createWorkspace(['worker', 'diag']);
    const runner = makeRunner(workspace);
    const execSpy = vi.spyOn(runner as any, 'execNonInteractive');
    const logSpy = vi.spyOn(runner as any, 'log').mockImplementation(() => {});

    queuedSubprocessResults = [
      { stdout: 'first attempt\n', code: 0 },
      { error: new Error('diagnostic exploded') },
      {
        stdout: 'second attempt\n',
        code: 0,
        beforeClose: () => {
          writeFileSync(path.join(workspace, 'ready.txt'), 'ok');
        },
      },
    ];

    const result = await runner.execute(
      makeConfig({
        workspace,
        verification: {
          type: 'custom',
          value: verificationCommand(),
          diagnosticAgent: 'diag',
        },
      }),
      'default'
    );

    expect(result.status, result.error).toBe('completed');
    expect(execSpy).toHaveBeenCalledTimes(3);

    const retryTask = taskFromExecCall(execSpy, 2);
    expect(retryTask).toContain('[VERIFICATION FAILED]');
    expect(retryTask).toContain('compile error: missing semicolon');
    expect(retryTask).not.toContain('Diagnostic analysis:');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Diagnostic failed'));
  });

  it('diagnosticAgent name validated against agent list', () => {
    expect(() => {
      workflow('traceback')
        .agent('worker', { cli: 'claude' })
        .step('implement', {
          agent: 'worker',
          task: 'Implement the requested change',
          retries: 1,
          verification: {
            type: 'custom',
            value: 'exit 1',
            diagnosticAgent: 'nonexistent',
          },
        })
        .toConfig();
    }).toThrow('Step "implement" references unknown diagnosticAgent "nonexistent"');
  });

  it('diagnostic token usage recorded in budget tracker', async () => {
    const workspace = createWorkspace(['worker', 'diag']);
    const runner = makeRunner(workspace);

    queuedSubprocessResults = [
      { stdout: 'first attempt\n', code: 0 },
      { stdout: 'The issue is in file X, line Y: missing semicolon\n', code: 0 },
      {
        stdout: 'second attempt\n',
        code: 0,
        beforeClose: () => {
          writeFileSync(path.join(workspace, 'ready.txt'), 'ok');
        },
      },
    ];
    queuedCollectorResults = [null, makeReport({ input: 40, output: 10 }), null];

    const result = await runner.execute(
      makeConfig({
        workspace,
        swarm: { tokenBudget: 1_000 },
        verification: {
          type: 'custom',
          value: verificationCommand(),
          diagnosticAgent: 'diag',
        },
      }),
      'default'
    );

    const tracker = getBudgetTracker(runner);

    expect(result.status, result.error).toBe('completed');
    expect(mockCollectCliSession).toHaveBeenCalledTimes(3);
    expect(tracker?.getTotalUsage()).toEqual({
      input: 40,
      output: 10,
      cacheRead: 0,
      total: 50,
    });
  });

  it('no retries configured with diagnosticAgent logs warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    workflow('traceback')
      .agent('worker', { cli: 'claude' })
      .agent('diag', { cli: 'claude' })
      .step('implement', {
        agent: 'worker',
        task: 'Implement the requested change',
        retries: 0,
        verification: {
          type: 'custom',
          value: 'exit 1',
          diagnosticAgent: 'diag',
        },
      })
      .toConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      'Step "implement": diagnosticAgent configured but no retries — diagnostic will never run'
    );
  });
});
