/**
 * Tests for the startFrom workflow execution feature.
 *
 * Validates that callers can start a workflow from a specific step,
 * skipping all predecessor steps and loading cached outputs when available.
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const { workflow } = await import('../workflows/builder.js');

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

function makeLinearConfig(): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-start-from',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-1', agent: 'agent-a', task: 'Do step 1' },
          { name: 'step-2', agent: 'agent-a', task: 'Do step 2', dependsOn: ['step-1'] },
          { name: 'step-3', agent: 'agent-a', task: 'Do step 3', dependsOn: ['step-2'] },
        ],
      },
    ],
    trajectories: false,
  };
}

function makeDiamondConfig(): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-diamond',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'root', agent: 'agent-a', task: 'Root step' },
          { name: 'left', agent: 'agent-a', task: 'Left branch', dependsOn: ['root'] },
          { name: 'right', agent: 'agent-a', task: 'Right branch', dependsOn: ['root'] },
          { name: 'merge', agent: 'agent-a', task: 'Merge', dependsOn: ['left', 'right'] },
        ],
      },
    ],
    trajectories: false,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('startFrom', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    mockRelayInstance.onWorkerOutput = null;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'start-from-'));
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test', cwd: tmpDir });
  });

  it('should throw when startFrom step does not exist', async () => {
    const config = makeLinearConfig();
    await expect(
      runner.execute(config, 'default', undefined, { startFrom: 'nonexistent' })
    ).rejects.toThrow('startFrom step "nonexistent" not found in workflow');
  });

  it('should skip predecessor steps in a linear chain', async () => {
    const config = makeLinearConfig();
    const events: Array<{ type: string; stepName?: string }> = [];
    runner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await runner.execute(config, 'default', undefined, { startFrom: 'step-3' });
    expect(run.status, run.error).toBe('completed');

    // step-1 and step-2 should NOT have step:started events (they were pre-completed)
    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).not.toContain('step-1');
    expect(startedSteps).not.toContain('step-2');
    expect(startedSteps).toContain('step-3');
  });

  it('should skip all transitive deps in a diamond DAG', async () => {
    const config = makeDiamondConfig();
    const events: Array<{ type: string; stepName?: string }> = [];
    runner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await runner.execute(config, 'default', undefined, { startFrom: 'merge' });
    expect(run.status, run.error).toBe('completed');

    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).not.toContain('root');
    expect(startedSteps).not.toContain('left');
    expect(startedSteps).not.toContain('right');
    expect(startedSteps).toContain('merge');
  });

  it('should load cached output from disk for skipped steps', async () => {
    const config = makeLinearConfig();

    // Pre-create cached output for step-1 (simulating a prior run)
    // We need to intercept the runId to write to the correct path.
    // Instead, we'll verify updateStep was called with expected output.
    const run = await runner.execute(config, 'default', undefined, { startFrom: 'step-2' });
    expect(run.status, run.error).toBe('completed');

    // step-1 should have been marked completed with empty string (no cached output)
    const updateCalls = (db.updateStep as any).mock.calls as Array<[string, Partial<WorkflowStepRow>]>;
    const step1Completion = updateCalls.find(
      ([_, patch]) => patch.status === 'completed' && patch.output === ''
    );
    expect(step1Completion).toBeDefined();
  });

  it('should load cached output when available on disk', async () => {
    const config = makeLinearConfig();

    // Chain additional logic onto the existing insertRun mock to write cached output
    const origImpl = (db.insertRun as any).getMockImplementation();
    (db.insertRun as any).mockImplementation(async (run: WorkflowRunRow) => {
      await origImpl(run);
      // Write cached output for step-1 so startFrom can find it
      const outputDir = path.join(tmpDir, '.agent-relay', 'step-outputs', run.id);
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(path.join(outputDir, 'step-1.md'), 'cached-output-from-step-1');
    });

    const run = await runner.execute(config, 'default', undefined, { startFrom: 'step-2' });
    expect(run.status, run.error).toBe('completed');

    // Verify step-1 was marked completed with the cached output
    const updateCalls = (db.updateStep as any).mock.calls as Array<[string, Partial<WorkflowStepRow>]>;
    const step1WithCachedOutput = updateCalls.find(
      ([_, patch]) => patch.status === 'completed' && patch.output === 'cached-output-from-step-1'
    );
    expect(step1WithCachedOutput).toBeDefined();
  });

  it('should work when startFrom targets the first step (no deps to skip)', async () => {
    const config = makeLinearConfig();
    const events: Array<{ type: string; stepName?: string }> = [];
    runner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await runner.execute(config, 'default', undefined, { startFrom: 'step-1' });
    expect(run.status, run.error).toBe('completed');

    // All 3 steps should start since step-1 has no deps
    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).toContain('step-1');
    expect(startedSteps).toContain('step-2');
    expect(startedSteps).toContain('step-3');
  });

  it('should work with builder .startFrom() chainable method', () => {
    const config = workflow('test')
      .agent('worker', { cli: 'claude' })
      .step('build', { agent: 'worker', task: 'Build' })
      .step('test', { agent: 'worker', task: 'Test', dependsOn: ['build'] })
      .step('deploy', { agent: 'worker', task: 'Deploy', dependsOn: ['test'] })
      .startFrom('deploy')
      .toConfig();

    // toConfig() should still produce valid config — startFrom is a runtime option
    expect(config.workflows![0].steps).toHaveLength(3);
    expect(config.agents).toHaveLength(1);
  });

  it('should pass startFrom from WorkflowRunOptions', async () => {
    const config = makeLinearConfig();
    const events: Array<{ type: string; stepName?: string }> = [];

    // Test via runner.execute directly with options
    runner.on((event) => {
      if ('stepName' in event) {
        events.push({ type: event.type, stepName: event.stepName });
      }
    });

    const run = await runner.execute(config, 'default', undefined, { startFrom: 'step-2' });
    expect(run.status, run.error).toBe('completed');

    const startedSteps = events.filter((e) => e.type === 'step:started').map((e) => e.stepName);
    expect(startedSteps).not.toContain('step-1');
    expect(startedSteps).toContain('step-2');
    expect(startedSteps).toContain('step-3');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
});
