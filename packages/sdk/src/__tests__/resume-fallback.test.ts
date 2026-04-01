/**
 * Tests for resuming workflow execution from cached step outputs when the JSONL
 * run database is missing or unavailable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowDb } from '../workflows/runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../workflows/types.js';

// ── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { api_key: 'rk_live_test', workspace_id: 'ws-test' } }),
  text: () => Promise.resolve(''),
});
vi.stubGlobal('fetch', mockFetch);

// ── Mock RelayCast SDK ───────────────────────────────────────────────────────

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

class MockRelayError extends Error {
  code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
    (this as any).status = status;
  }
}

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => mockRelaycast),
  RelayError: MockRelayError,
}));

// ── Mock AgentRelay ──────────────────────────────────────────────────────────

let waitForExitFn: (ms?: number) => Promise<'exited' | 'timeout' | 'released'>;

const mockAgent = {
  name: 'test-agent-abc',
  get waitForExit() { return waitForExitFn; },
  get waitForIdle() { return vi.fn().mockImplementation(() => new Promise(() => {})); },
  release: vi.fn().mockResolvedValue(undefined),
};

const mockHuman = {
  name: 'WorkflowRunner',
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

const mockRelayInstance = {
  spawnPty: vi.fn().mockImplementation(async ({ name, task }: { name: string; task?: string }) => {
    const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/)?.[1]?.trim();
    const isReview = task?.includes('REVIEW_DECISION: APPROVE or REJECT');
    const output = isReview
      ? 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n'
      : stepComplete
        ? `STEP_COMPLETE:${stepComplete}\n`
        : 'STEP_COMPLETE:unknown\n';

    queueMicrotask(() => {
      if (typeof mockRelayInstance.onWorkerOutput === 'function') {
        mockRelayInstance.onWorkerOutput({ name, chunk: output });
      }
    });

    return { ...mockAgent, name };
  }),
  human: vi.fn().mockReturnValue(mockHuman),
  shutdown: vi.fn().mockResolvedValue(undefined),
  onBrokerStderr: vi.fn().mockReturnValue(() => {}),
  onWorkerOutput: null as ((frame: { name: string; chunk: string }) => void) | null,
  onMessageReceived: null as any,
  onAgentSpawned: null as any,
  onAgentReleased: null as any,
  onAgentExited: null as any,
  onAgentIdle: null as any,
  onDeliveryUpdate: null as any,
  listAgentsRaw: vi.fn().mockResolvedValue([]),
};

vi.mock('../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

// Import after mocking
const { WorkflowRunner } = await import('../workflows/runner.js');
const { JsonFileWorkflowDb } = await import('../workflows/file-db.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();

  return {
    insertRun: vi.fn(async (run: WorkflowRunRow) => {
      runs.set(run.id, { ...run });
    }),
    updateRun: vi.fn(async (id: string, patch: Partial<WorkflowRunRow>) => {
      const existing = runs.get(id);
      if (existing) runs.set(id, { ...existing, ...patch });
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
      if (existing) steps.set(id, { ...existing, ...patch });
    }),
    getStepsByRunId: vi.fn(async (runId: string) => {
      return [...steps.values()].filter((s) => s.runId === runId);
    }),
  };
}

function makeResumeConfig(): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-resume-fallback',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', agent: 'agent-a', task: 'Do step A' },
          { name: 'step-b', agent: 'agent-a', task: 'Do step B', dependsOn: ['step-a'] },
          { name: 'step-c', agent: 'agent-a', task: 'Do step C', dependsOn: ['step-b'] },
        ],
      },
    ],
    trajectories: false,
  };
}

function makeTemplateConfig(): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-resume-template',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', agent: 'agent-a', task: 'Generate input' },
          {
            name: 'step-b',
            agent: 'agent-a',
            task: 'Use cached value: {{steps.step-a.output}}',
            dependsOn: ['step-a'],
          },
        ],
      },
    ],
    trajectories: false,
  };
}

function makeRunRow(runId: string, config: RelayYamlConfig, status: WorkflowRunRow['status'] = 'failed'): WorkflowRunRow {
  const now = new Date().toISOString();
  return {
    id: runId,
    workspaceId: 'ws-test',
    workflowName: 'default',
    pattern: config.swarm.pattern,
    status,
    config,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function makeStepRow(
  runId: string,
  stepName: string,
  task: string,
  dependsOn: string[] = [],
  status: WorkflowStepRow['status'] = 'pending',
  output?: string
): WorkflowStepRow {
  const now = new Date().toISOString();
  return {
    id: `${runId}-${stepName}`,
    runId,
    stepName,
    agentName: 'agent-a',
    stepType: 'agent',
    status,
    task,
    dependsOn,
    output,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: status !== 'pending' ? now : undefined,
    completedAt: status === 'completed' ? now : undefined,
  };
}

function writeCachedOutput(tmpDir: string, runId: string, stepName: string, output: string): void {
  const outputDir = path.join(tmpDir, '.agent-relay', 'step-outputs', runId);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, `${stepName}.md`), output);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('resume fallback to step-output cache', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    mockRelayInstance.onWorkerOutput = null;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'resume-fallback-'));
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test', cwd: tmpDir });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('should reconstruct run from step-output cache when JSONL missing', async () => {
    const runId = 'resume-cache-run';
    const config = makeResumeConfig();
    writeCachedOutput(tmpDir, runId, 'step-a', 'cached-a');
    writeCachedOutput(tmpDir, runId, 'step-b', 'cached-b');

    const events: Array<{ type: string; stepName?: string }> = [];
    runner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await (runner as any).resume(runId, undefined, config);
    expect(run.status, run.error).toBe('completed');

    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).not.toContain('step-a');
    expect(startedSteps).not.toContain('step-b');
    expect(startedSteps).toContain('step-c');
  });

  it('should throw "not found" when neither JSONL nor cache exists', async () => {
    const config = makeResumeConfig();

    await expect((runner as any).resume('nonexistent-id', undefined, config)).rejects.toThrow('not found');
  });

  it('should prefer JSONL database over step-output cache', async () => {
    const runId = 'resume-db-run';
    const config = makeResumeConfig();
    const dbPath = path.join(tmpDir, '.agent-relay', 'workflow-runs.jsonl');
    const fileDb = new JsonFileWorkflowDb(dbPath);
    const dbRunner = new WorkflowRunner({ db: fileDb, workspaceId: 'ws-test', cwd: tmpDir });

    await fileDb.insertRun(makeRunRow(runId, config));
    await fileDb.insertStep(makeStepRow(runId, 'step-a', 'Do step A', [], 'failed'));
    await fileDb.insertStep(makeStepRow(runId, 'step-b', 'Do step B', ['step-a'], 'pending'));
    await fileDb.insertStep(makeStepRow(runId, 'step-c', 'Do step C', ['step-b'], 'pending'));

    writeCachedOutput(tmpDir, runId, 'step-a', 'cached-a-from-fallback');

    const events: Array<{ type: string; stepName?: string }> = [];
    dbRunner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await dbRunner.resume(runId);
    expect(run.status, run.error).toBe('completed');

    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).toContain('step-a');
    expect(startedSteps).toContain('step-b');
    expect(startedSteps).toContain('step-c');
  });

  it('should handle empty step-output directory gracefully', async () => {
    const runId = 'resume-empty-cache';
    const config = makeResumeConfig();
    mkdirSync(path.join(tmpDir, '.agent-relay', 'step-outputs', runId), { recursive: true });

    const events: Array<{ type: string; stepName?: string }> = [];
    runner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await (runner as any).resume(runId, undefined, config);
    expect(run.status, run.error).toBe('completed');

    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).toContain('step-a');
    expect(startedSteps).toContain('step-b');
    expect(startedSteps).toContain('step-c');
  });

  it('should load cached output into step template variables', async () => {
    const runId = 'resume-template-cache';
    const config = makeTemplateConfig();
    writeCachedOutput(tmpDir, runId, 'step-a', 'hello world');

    const run = await (runner as any).resume(runId, undefined, config);
    expect(run.status, run.error).toBe('completed');

    const spawnedTasks = mockRelayInstance.spawnPty.mock.calls.map(
      ([args]) => (args as { task?: string }).task ?? ''
    );
    expect(spawnedTasks.some((task) => task.includes('Use cached value: hello world'))).toBe(true);
  });

  it('should skip .report.json files when scanning step outputs', async () => {
    const runId = 'resume-report-cache';
    const config = makeResumeConfig();
    const outputDir = path.join(tmpDir, '.agent-relay', 'step-outputs', runId);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, 'step-a.md'), 'cached-a');
    writeFileSync(path.join(outputDir, 'step-a.report.json'), '{"summary":"done"}');
    writeFileSync(path.join(outputDir, 'step-b.report.json'), '{"summary":"metadata only"}');

    const events: Array<{ type: string; stepName?: string }> = [];
    runner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await (runner as any).resume(runId, undefined, config);
    expect(run.status, run.error).toBe('completed');

    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).not.toContain('step-a');
    expect(startedSteps).toContain('step-b');
    expect(startedSteps).toContain('step-c');
  });
});

describe('file-db append diagnostics', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'file-db-warn-'));
  });

  afterEach(() => {
    try {
      chmodSync(path.join(tmpDir, 'readonly'), 0o755);
    } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('should warn once when append fails', async () => {
    const readonlyDir = path.join(tmpDir, 'readonly');
    mkdirSync(readonlyDir, { recursive: true });
    chmodSync(readonlyDir, 0o555);

    const dbPath = path.join(readonlyDir, 'workflow-runs.jsonl');
    const fileDb = new JsonFileWorkflowDb(dbPath);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = makeResumeConfig();

    await fileDb.insertRun(makeRunRow('warn-run-1', config));
    await fileDb.insertRun(makeRunRow('warn-run-2', config));

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
