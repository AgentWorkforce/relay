import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BudgetTracker } from '../budget-tracker.js';
import type { CliSessionQuery, CliSessionReport } from '../cli-session-collector.js';
import type { WorkflowDb } from '../runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../types.js';

const tempDirs: string[] = [];

type QueuedSubprocessResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  delayMs?: number;
  error?: Error;
  onSpawn?: () => void;
};

type CollectorResult =
  | CliSessionReport
  | null
  | ((query: CliSessionQuery) => CliSessionReport | null | Promise<CliSessionReport | null>);

let queuedSubprocessResults: QueuedSubprocessResult[] = [];
let queuedCollectorResults: CollectorResult[] = [];
let collectorResultsByCwd = new Map<string, CollectorResult>();
let activeRunner: InstanceType<typeof WorkflowRunner> | undefined;

const mockCollectCliSession = vi.fn(async (query: CliSessionQuery): Promise<CliSessionReport | null> => {
  const next =
    queuedCollectorResults.length > 0 ? queuedCollectorResults.shift() : collectorResultsByCwd.get(query.cwd);

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
  child.kill = vi.fn();

  result.onSpawn?.();

  const emitResult = () => {
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
    child.emit('close', result.code ?? 0, result.signal ?? null);
  };

  if (result.delayMs && result.delayMs > 0) {
    setTimeout(emitResult, result.delayMs);
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

const mockRelayInstance = {
  spawnPty: vi.fn(),
  human: vi.fn().mockReturnValue({ sendMessage: vi.fn().mockResolvedValue(undefined) }),
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

const { WorkflowRunner } = await import('../runner.js');

interface DbHarness {
  db: WorkflowDb;
  getRun(id: string): WorkflowRunRow | null;
  getSteps(runId: string): WorkflowStepRow[];
}

function makeDbHarness(): DbHarness {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    db: {
      insertRun: vi.fn(async (run: WorkflowRunRow) => {
        runs.set(run.id, { ...run });
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
      insertStep: vi.fn(async (step: WorkflowStepRow) => {
        steps.set(step.id, { ...step });
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
    },
    getRun(id: string) {
      const run = runs.get(id);
      return run ? { ...run } : null;
    },
    getSteps(runId: string) {
      return [...steps.values()].filter((step) => step.runId === runId).map((step) => ({ ...step }));
    },
  };
}

function createWorkspace(subdirs: string[] = []): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-budget-enforcement-'));
  tempDirs.push(dir);

  for (const subdir of subdirs) {
    mkdirSync(path.join(dir, subdir), { recursive: true });
  }

  return dir;
}

function makeRunner(cwd: string, db: WorkflowDb): InstanceType<typeof WorkflowRunner> {
  return new WorkflowRunner({
    cwd,
    db,
    workspaceId: 'ws-test',
    relay: {
      env: {
        AGENT_RELAY_WORKFLOW_DISABLE_RELAYCAST: '1',
      },
    },
  });
}

function makeAgent(
  name: string,
  overrides: Partial<RelayYamlConfig['agents'][number]> = {}
): RelayYamlConfig['agents'][number] {
  return {
    name,
    cli: 'claude',
    interactive: false,
    ...overrides,
  };
}

function makeStep(
  name: string,
  agent: string,
  overrides: Partial<NonNullable<RelayYamlConfig['workflows']>[number]['steps'][number]> = {}
): NonNullable<RelayYamlConfig['workflows']>[number]['steps'][number] {
  return {
    name,
    agent,
    task: `Complete ${name}`,
    ...overrides,
  };
}

function makeConfig(input: {
  agents: RelayYamlConfig['agents'];
  steps: NonNullable<RelayYamlConfig['workflows']>[number]['steps'];
  swarm?: Partial<RelayYamlConfig['swarm']>;
}): RelayYamlConfig {
  return {
    version: '1',
    name: 'budget-enforcement',
    swarm: {
      pattern: 'dag',
      ...input.swarm,
    },
    agents: input.agents,
    workflows: [
      {
        name: 'default',
        steps: input.steps,
      },
    ],
    trajectories: false,
  };
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

function getBudgetTracker(runner: InstanceType<typeof WorkflowRunner>): BudgetTracker | undefined {
  return (runner as any).budgetTracker as BudgetTracker | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  queuedSubprocessResults = [];
  queuedCollectorResults = [];
  collectorResultsByCwd = new Map();
  activeRunner = undefined;
  mockRelayInstance.shutdown.mockResolvedValue(undefined);
  mockRelayInstance.onBrokerStderr.mockReturnValue(() => {});
  mockRelayInstance.listAgents.mockResolvedValue([]);
});

afterEach(() => {
  activeRunner = undefined;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('WorkflowRunner budget enforcement integration', () => {
  it('workflow with no budget config runs normally', async () => {
    const workspace = createWorkspace(['step-1', 'step-2']);
    const dbHarness = makeDbHarness();
    const runner = makeRunner(workspace, dbHarness.db);
    activeRunner = runner;

    queuedSubprocessResults = [
      { stdout: 'step 1 complete\n', code: 0 },
      { stdout: 'step 2 complete\n', code: 0 },
    ];
    queuedCollectorResults = [null, null];

    const run = await runner.execute(
      makeConfig({
        agents: [makeAgent('worker-1', { cwd: 'step-1' }), makeAgent('worker-2', { cwd: 'step-2' })],
        steps: [makeStep('step-1', 'worker-1'), makeStep('step-2', 'worker-2', { dependsOn: ['step-1'] })],
      }),
      'default'
    );

    expect(run.status).toBe('completed');
    expect(getBudgetTracker(runner)).toBeUndefined();
    expect(dbHarness.getSteps(run.id).map((step) => step.status)).toEqual(['completed', 'completed']);
    expect(mockSubprocessSpawn).toHaveBeenCalledTimes(2);
  });

  it('per-agent maxTokens recorded in budget tracker', async () => {
    const workspace = createWorkspace(['writer']);
    const dbHarness = makeDbHarness();
    const runner = makeRunner(workspace, dbHarness.db);
    activeRunner = runner;

    queuedSubprocessResults = [{ stdout: 'draft complete\n', code: 0 }];
    collectorResultsByCwd.set(path.join(workspace, 'writer'), makeReport({ input: 800, output: 150 }));

    const run = await runner.execute(
      makeConfig({
        agents: [
          makeAgent('writer', {
            cwd: 'writer',
            constraints: { maxTokens: 1_000 },
          }),
        ],
        steps: [makeStep('draft', 'writer')],
      }),
      'default'
    );

    const tracker = getBudgetTracker(runner);

    expect(run.status).toBe('completed');
    expect(tracker).toBeDefined();
    expect(tracker?.getStepUsage('draft')).toEqual({
      input: 800,
      output: 150,
      cacheRead: 0,
      total: 950,
    });
    expect(tracker?.getStepBudgetStatus('draft')).toEqual({
      used: 950,
      limit: 1_000,
      over: false,
    });
  });

  it('per-workflow tokenBudget prevents spawning when exhausted', async () => {
    const workspace = createWorkspace(['planner', 'writer']);
    const dbHarness = makeDbHarness();
    const runner = makeRunner(workspace, dbHarness.db);
    activeRunner = runner;

    queuedSubprocessResults = [{ stdout: 'plan complete\n', code: 0 }];
    collectorResultsByCwd.set(path.join(workspace, 'planner'), makeReport({ input: 1_500, output: 300 }));

    const run = await runner.execute(
      makeConfig({
        agents: [makeAgent('planner', { cwd: 'planner' }), makeAgent('writer', { cwd: 'writer' })],
        steps: [makeStep('step-1', 'planner'), makeStep('step-2', 'writer', { dependsOn: ['step-1'] })],
        swarm: {
          tokenBudget: 2_000,
        },
      }),
      'default'
    );

    const tracker = getBudgetTracker(runner);
    const failedStep = dbHarness.getSteps(run.id).find((step) => step.stepName === 'step-2');

    expect(run.status).toBe('failed');
    expect(mockSubprocessSpawn).toHaveBeenCalledTimes(1);
    expect(tracker?.getTotalUsage().total).toBe(1_800);
    expect(failedStep?.status).toBe('failed');
    expect(failedStep?.error).toContain('workflow budget exhausted');
    expect(failedStep?.error).toContain('1800/2000');
  });

  it('pre-spawn check allows step when budget has headroom', async () => {
    const workspace = createWorkspace(['first', 'second']);
    const dbHarness = makeDbHarness();
    const runner = makeRunner(workspace, dbHarness.db);
    activeRunner = runner;

    let checkCanSpawnAllowed: boolean | undefined;

    queuedSubprocessResults = [
      { stdout: 'first complete\n', code: 0 },
      {
        stdout: 'second complete\n',
        code: 0,
        onSpawn: () => {
          checkCanSpawnAllowed = getBudgetTracker(runner)?.checkCanSpawn('step-2').allowed;
        },
      },
    ];
    collectorResultsByCwd.set(path.join(workspace, 'first'), makeReport({ input: 900, output: 100 }));
    collectorResultsByCwd.set(path.join(workspace, 'second'), makeReport({ input: 150, output: 50 }));

    const run = await runner.execute(
      makeConfig({
        agents: [makeAgent('first-agent', { cwd: 'first' }), makeAgent('second-agent', { cwd: 'second' })],
        steps: [
          makeStep('step-1', 'first-agent'),
          makeStep('step-2', 'second-agent', { dependsOn: ['step-1'] }),
        ],
        swarm: {
          tokenBudget: 5_000,
        },
      }),
      'default'
    );

    expect(run.status).toBe('completed');
    expect(checkCanSpawnAllowed).toBe(true);
    expect(mockSubprocessSpawn).toHaveBeenCalledTimes(2);
  });

  it('retry attempts consume from same budget', async () => {
    const workspace = createWorkspace(['retry-agent']);
    const dbHarness = makeDbHarness();
    const runner = makeRunner(workspace, dbHarness.db);
    activeRunner = runner;

    let usageBeforeRetry: number | undefined;

    queuedSubprocessResults = [
      { stdout: 'first attempt failed\n', code: 1 },
      {
        stdout: 'retry succeeded\n',
        code: 0,
        onSpawn: () => {
          usageBeforeRetry = getBudgetTracker(runner)?.getStepUsage('retry-step').total;
        },
      },
    ];
    queuedCollectorResults = [
      makeReport({ input: 500, output: 100 }, { finalStatus: 'failed' }),
      makeReport({ input: 250, output: 100 }),
    ];

    const run = await runner.execute(
      makeConfig({
        agents: [
          makeAgent('retry-agent', {
            cwd: 'retry-agent',
            constraints: { maxTokens: 1_000 },
          }),
        ],
        steps: [makeStep('retry-step', 'retry-agent', { retries: 1 })],
      }),
      'default'
    );

    const tracker = getBudgetTracker(runner);

    expect(run.status).toBe('completed');
    expect(usageBeforeRetry).toBe(600);
    expect(tracker?.getStepUsage('retry-step')).toEqual({
      input: 750,
      output: 200,
      cacheRead: 0,
      total: 950,
    });
    expect(tracker?.getStepBudgetStatus('retry-step')).toEqual({
      used: 950,
      limit: 1_000,
      over: false,
    });
    expect(mockCollectCliSession).toHaveBeenCalledTimes(2);
  });

  it('parallel steps track budget correctly', async () => {
    const workspace = createWorkspace(['parallel-a', 'parallel-b']);
    const dbHarness = makeDbHarness();
    const runner = makeRunner(workspace, dbHarness.db);
    activeRunner = runner;

    queuedSubprocessResults = [
      { stdout: 'parallel a\n', code: 0, delayMs: 10 },
      { stdout: 'parallel b\n', code: 0, delayMs: 1 },
    ];
    collectorResultsByCwd.set(path.join(workspace, 'parallel-a'), makeReport({ input: 500, output: 200 }));
    collectorResultsByCwd.set(path.join(workspace, 'parallel-b'), makeReport({ input: 700, output: 200 }));

    const run = await runner.execute(
      makeConfig({
        agents: [
          makeAgent('parallel-a', { cwd: 'parallel-a' }),
          makeAgent('parallel-b', { cwd: 'parallel-b' }),
        ],
        steps: [makeStep('parallel-a', 'parallel-a'), makeStep('parallel-b', 'parallel-b')],
        swarm: {
          tokenBudget: 5_000,
        },
      }),
      'default'
    );

    const tracker = getBudgetTracker(runner);

    expect(run.status).toBe('completed');
    expect(tracker?.getStepUsage('parallel-a')).toEqual({
      input: 500,
      output: 200,
      cacheRead: 0,
      total: 700,
    });
    expect(tracker?.getStepUsage('parallel-b')).toEqual({
      input: 700,
      output: 200,
      cacheRead: 0,
      total: 900,
    });
    expect(tracker?.getTotalUsage()).toEqual({
      input: 1_200,
      output: 400,
      cacheRead: 0,
      total: 1_600,
    });
    expect(tracker?.getRunSummaryBudgetData()?.workflow).toEqual({
      used: 1_600,
      limit: 5_000,
      exhausted: false,
    });
  });
});
