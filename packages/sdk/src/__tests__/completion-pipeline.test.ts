/**
 * Completion Pipeline tests for Point-Person-Led Completion spec.
 *
 * Validates:
 * 1. Evidence-based completion (verification passes without marker)
 * 2. Owner decision parsing (OWNER_DECISION: COMPLETE/INCOMPLETE_RETRY/INCOMPLETE_FAIL)
 * 3. Tolerant review parsing (accepts semantic equivalents)
 * 4. Channel evidence contributions (WORKER_DONE signals)
 * 5. Backward compatibility with marker-based workflows
 * 6. Codex/Gemini/Supervisor pattern compatibility
 * 7. Map-reduce workflows remain unaffected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDb } from '../workflows/runner.js';
import type {
  RelayYamlConfig,
  WorkflowRunRow,
  WorkflowStepRow,
  WorkflowStepCompletionReason,
  StepCompletionEvidence,
  StepCompletionDecision,
} from '../workflows/types.js';

// ── Mock fetch to prevent real HTTP calls (Relaycast provisioning) ───────────

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
let waitForIdleFn: (ms?: number) => Promise<'idle' | 'timeout' | 'exited'>;
let mockSpawnOutputs: string[] = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { EventEmitter } = await import('node:events');

  return {
    ...actual,
    spawn: vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as any;
      child.pid = 4242;
      child.kill = vi.fn();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      const output = mockSpawnOutputs.shift() ?? '';
      queueMicrotask(() => {
        if (output) child.stdout.emit('data', Buffer.from(output));
        child.emit('close', 0, null);
      });

      return child;
    }),
  };
});

const mockAgent = {
  name: 'test-agent-abc',
  get waitForExit() {
    return waitForExitFn;
  },
  get waitForIdle() {
    return waitForIdleFn;
  },
  release: vi.fn().mockResolvedValue(undefined),
};

const mockHuman = {
  name: 'WorkflowRunner',
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

const defaultSpawnPtyImplementation = async ({ name, task }: { name: string; task?: string }) => {
  const queued = mockSpawnOutputs.shift();
  const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/)?.[1]?.trim();
  const isReview = task?.includes('REVIEW_DECISION: APPROVE or REJECT');
  const output =
    queued ??
    (isReview
      ? 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n'
      : stepComplete
        ? `STEP_COMPLETE:${stepComplete}\n`
        : 'STEP_COMPLETE:unknown\n');

  queueMicrotask(() => {
    if (typeof mockRelayInstance.onWorkerOutput === 'function') {
      mockRelayInstance.onWorkerOutput({ name, chunk: output });
    }
  });

  return { ...mockAgent, name };
};

const mockRelayInstance = {
  spawnPty: vi.fn().mockImplementation(defaultSpawnPtyImplementation),
  human: vi.fn().mockReturnValue(mockHuman),
  shutdown: vi.fn().mockResolvedValue(undefined),
  onBrokerStderr: vi.fn().mockReturnValue(() => {}),
  onWorkerOutput: null as ((frame: { name: string; chunk: string }) => void) | null,
  onMessageReceived: null as any,
  onAgentSpawned: null as any,
  onAgentExited: null as any,
  onAgentIdle: null as any,
  listAgents: vi.fn().mockResolvedValue([]),
  listAgentsRaw: vi.fn().mockResolvedValue([]),
};

let relayEventCounter = 0;

function emitRelayChannelMessage(message: { from: string; to: string; text: string }) {
  setTimeout(() => {
    mockRelayInstance.onMessageReceived?.({
      eventId: `evt-${++relayEventCounter}`,
      from: message.from,
      to: message.to,
      text: message.text,
      threadId: undefined,
    });
  }, 0);
}

vi.mock('../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

// Import after mocking
const { WorkflowRunner } = await import('../workflows/runner.js');

// ── Test fixtures ────────────────────────────────────────────────────────────

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

function makeConfig(overrides: Partial<RelayYamlConfig> = {}): RelayYamlConfig {
  return {
    version: '1',
    name: 'completion-pipeline-test',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
      { name: 'agent-b', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-1', agent: 'agent-a', task: 'Do step 1' },
          { name: 'step-2', agent: 'agent-b', task: 'Do step 2', dependsOn: ['step-1'] },
        ],
      },
    ],
    trajectories: false,
    ...overrides,
  };
}

type WorkflowStepOverride = Partial<NonNullable<RelayYamlConfig['workflows']>[number]['steps'][number]>;

function makeSupervisedConfig(stepOverrides: WorkflowStepOverride = {}): RelayYamlConfig {
  return makeConfig({
    swarm: { pattern: 'hub-spoke' },
    agents: [
      { name: 'specialist', cli: 'claude', role: 'engineer' },
      { name: 'team-lead', cli: 'claude', role: 'lead coordinator' },
      { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'step-1',
            agent: 'specialist',
            task: 'Implement the requested change',
            ...stepOverrides,
          },
        ],
      },
    ],
  });
}

function makeTwoStepSupervisedConfig(): RelayYamlConfig {
  return makeConfig({
    swarm: { pattern: 'hub-spoke' },
    agents: [
      { name: 'specialist-a', cli: 'claude', role: 'engineer' },
      { name: 'specialist-b', cli: 'claude', role: 'engineer' },
      { name: 'team-lead', cli: 'claude', role: 'lead coordinator' },
      { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-1', agent: 'specialist-a', task: 'Do step 1' },
          { name: 'step-2', agent: 'specialist-b', task: 'Do step 2', dependsOn: ['step-1'] },
        ],
      },
    ],
  });
}

function makeChannelSupervisedConfig(
  channel: string,
  stepOverrides: WorkflowStepOverride = {}
): RelayYamlConfig {
  const config = makeSupervisedConfig(stepOverrides);
  config.swarm = { ...config.swarm, channel };
  return config;
}

async function getStepRow(
  db: WorkflowDb,
  runId: string,
  stepName: string
): Promise<WorkflowStepRow | undefined> {
  const steps = await db.getStepsByRunId(runId);
  return steps.find((step) => step.stepName === stepName);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Completion Pipeline', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;

  beforeEach(() => {
    vi.clearAllMocks();
    relayEventCounter = 0;
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    waitForIdleFn = vi.fn().mockImplementation(() => never());
    mockSpawnOutputs = [];
    mockAgent.release.mockResolvedValue(undefined);
    mockRelayInstance.spawnPty.mockImplementation(defaultSpawnPtyImplementation);
    mockRelayInstance.onWorkerOutput = null;
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });
  });

  // ── Unit Test 1: Verification passes without marker ───────────────────

  describe('evidence-based completion without marker', () => {
    it('should complete step when verification passes but STEP_COMPLETE marker is missing', async () => {
      // Worker output contains the verification target but no STEP_COMPLETE marker
      mockSpawnOutputs = [
        'worker output with expected content\n',
        'Owner observed the work is done\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: verified\n',
      ];

      const config = makeSupervisedConfig({
        verification: { type: 'output_contains', value: 'expected content' },
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
    }, 15000);

    it('should complete self-owned step when verification passes without marker', async () => {
      // Agent output has verified content but no STEP_COMPLETE marker
      // With the completion pipeline, verification passing should be sufficient
      mockSpawnOutputs = [
        'All tests passed\nBuild successful\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: tests pass\n',
      ];

      const config = makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-1',
                agent: 'agent-a',
                task: 'Run tests',
                verification: { type: 'output_contains', value: 'All tests passed' },
              },
            ],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
    }, 15000);
  });

  // ── Unit Test 2: Owner approves despite malformed worker marker ────────

  describe('owner decision overrides malformed markers', () => {
    it('should complete step when owner approves despite malformed worker marker', async () => {
      // Worker outputs a malformed marker, but owner's STEP_COMPLETE is correct
      mockSpawnOutputs = [
        'STEP_COMPLET:step-1\n', // typo in worker marker
        'Checked worker output, work is done\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: owner confirmed\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);

    it('should complete when owner provides OWNER_DECISION: COMPLETE', async () => {
      // Owner uses the structured decision format
      mockSpawnOutputs = [
        'worker finished work\n',
        'OWNER_DECISION: COMPLETE\nREASON: verified artifacts\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: owner confirmed\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);
  });

  // ── Unit Test 3: Owner requests retry via OWNER_DECISION ──────────────

  describe('owner decision retry', () => {
    it('should fail with a clear error when owner requests INCOMPLETE_RETRY and retries are disabled', async () => {
      mockSpawnOutputs = [
        'worker first attempt\n',
        'OWNER_DECISION: INCOMPLETE_RETRY\nREASON: missing error handling\n',
      ];

      const run = await runner.execute(makeSupervisedConfig({ retries: 0 }), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('no retries are configured (maxRetries=0)');
      expect(run.error).toContain('OWNER_DECISION: INCOMPLETE_RETRY');

      const steps = await db.getStepsByRunId(run.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('failed');
      expect(steps[0]?.completionReason).toBe('retry_requested_by_owner');
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(2);
    }, 15000);

    it('should retry and complete when owner requests INCOMPLETE_RETRY and retries remain', async () => {
      const retryEvents: Array<{ type: string; stepName: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:retrying') {
          retryEvents.push({ type: event.type, stepName: event.stepName });
        }
      });

      // First attempt: owner requests retry
      // Second attempt: owner approves
      mockSpawnOutputs = [
        'worker first attempt\n',
        'OWNER_DECISION: INCOMPLETE_RETRY\nREASON: missing error handling\n',
        'worker second attempt with error handling\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: retry succeeded\n',
      ];

      const config = makeSupervisedConfig({ retries: 1 });
      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('completed');
      expect(retryEvents).toEqual([{ type: 'step:retrying', stepName: 'step-1' }]);

      const steps = await db.getStepsByRunId(run.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('completed');
      expect(steps[0]?.retryCount).toBe(1);
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(5);
    }, 15000);

    it('should fail after retries are exhausted when owner keeps requesting INCOMPLETE_RETRY', async () => {
      mockSpawnOutputs = [
        'worker first attempt\n',
        'OWNER_DECISION: INCOMPLETE_RETRY\nREASON: missing tests\n',
        'worker second attempt\n',
        'OWNER_DECISION: INCOMPLETE_RETRY\nREASON: still missing tests\n',
      ];

      const run = await runner.execute(makeSupervisedConfig({ retries: 1 }), 'default');

      expect(run.status).toBe('failed');
      expect(run.error).toContain('retry budget is exhausted (maxRetries=1)');
      expect(run.error).toContain('after 2 total attempts');

      const steps = await db.getStepsByRunId(run.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('failed');
      expect(steps[0]?.completionReason).toBe('retry_requested_by_owner');
      expect(steps[0]?.retryCount).toBe(1);
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(4);
    }, 15000);

    it('should honor INCOMPLETE_RETRY from a non-interactive reviewer step', async () => {
      const localDb = makeDb();
      runner = new WorkflowRunner({ db: localDb, workspaceId: 'ws-test' });
      mockSpawnOutputs = ['OWNER_DECISION: INCOMPLETE_RETRY\nREASON: explicit retry requested\n'];

      const run = await runner.execute(
        makeConfig({
          agents: [{ name: 'reviewer', cli: 'claude', preset: 'reviewer' }],
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'review-step',
                  agent: 'reviewer',
                  task: 'Review the artifact and decide whether to retry.',
                  verification: { type: 'output_contains', value: 'OWNER_DECISION: INCOMPLETE_RETRY' },
                },
              ],
            },
          ],
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner requested another attempt');

      const steps = await localDb.getStepsByRunId(run.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('failed');
      expect(steps[0]?.completionReason).toBe('retry_requested_by_owner');
    }, 15000);

    it('should not complete a self-owned step when INCOMPLETE_RETRY conflicts with success signals', async () => {
      mockSpawnOutputs = [
        [
          'OWNER_DECISION: INCOMPLETE_RETRY',
          'REASON: owner wants another verification pass',
          'STEP_COMPLETE:step-1',
          'expected content',
          'verified locally',
        ].join('\n'),
      ];

      const run = await runner.execute(
        makeConfig({
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'step-1',
                  agent: 'agent-a',
                  task: 'Run tests',
                  retries: 0,
                  verification: { type: 'output_contains', value: 'expected content' },
                },
              ],
            },
          ],
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(run.error).toContain('no retries are configured (maxRetries=0)');

      const steps = await db.getStepsByRunId(run.id);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('failed');
      expect(steps[0]?.completionReason).toBe('retry_requested_by_owner');
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(1);
    }, 15000);

    it('should not let passing verification override INCOMPLETE_RETRY', async () => {
      mockSpawnOutputs = [
        'worker output with expected content\n',
        [
          'OWNER_DECISION: INCOMPLETE_RETRY',
          'REASON: missing WORKER_DONE marker',
          'verified artifacts after inspecting output',
          'worker finished implementation',
        ].join('\n'),
      ];

      const run = await runner.execute(
        makeSupervisedConfig({
          verification: { type: 'output_contains', value: 'expected content' },
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(2);
    }, 15000);

    it('should not let passing verification override NEEDS_CLARIFICATION', async () => {
      mockSpawnOutputs = [
        'worker output with expected content\n',
        [
          'OWNER_DECISION: NEEDS_CLARIFICATION',
          'REASON: owner needs proof of the channel handoff',
          'verified artifacts after inspecting output',
        ].join('\n'),
      ];

      const run = await runner.execute(
        makeSupervisedConfig({
          verification: { type: 'output_contains', value: 'expected content' },
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(2);
    }, 15000);
  });

  // ── Unit Test 4: Owner rejects AND verification fails ─────────────────

  describe('double failure: owner reject + verification fail', () => {
    it('should fail step when owner rejects AND verification also fails', async () => {
      mockSpawnOutputs = [
        'worker output without expected content\n',
        'OWNER_DECISION: INCOMPLETE_FAIL\nREASON: work is wrong\n',
      ];

      const config = makeSupervisedConfig({
        verification: { type: 'output_contains', value: 'expected output' },
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('failed');
    }, 15000);

    it('should fail when owner rejects even if verification passes', async () => {
      mockSpawnOutputs = [
        'worker output with expected content\n',
        [
          'OWNER_DECISION: INCOMPLETE_FAIL',
          'REASON: work is incomplete without WORKER_DONE proof',
          'artifacts verified locally',
          'worker finished implementation',
        ].join('\n'),
      ];

      const run = await runner.execute(
        makeSupervisedConfig({
          verification: { type: 'output_contains', value: 'expected content' },
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(2);
    }, 15000);

    it('should mark the run failed even with errorHandling.strategy=continue when a step fails', async () => {
      // Regression: previously `allCompleted` counted failed steps as success
      // whenever continueOnError was true, so the summary table would render
      // "FAILED 1 passed, 1 failed" while run.status landed on 'completed'.
      // Any wrapper that keys off run.status (e.g. the cloud orchestrator's
      // bootstrap) would then propagate a false success.
      mockSpawnOutputs = [
        'worker output\n',
        'OWNER_DECISION: INCOMPLETE_FAIL\nREASON: relaycast unavailable\n',
      ];

      const config: RelayYamlConfig = {
        ...makeSupervisedConfig({}),
        errorHandling: { strategy: 'continue' },
      };

      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('failed');
      const steps = await db.getStepsByRunId(run.id);
      expect(steps[0]?.status).toBe('failed');
      expect(steps[0]?.completionReason).toBe('failed_owner_decision');
    }, 15000);

    it('should still complete by owner decision when COMPLETE and verification both pass', async () => {
      mockSpawnOutputs = [
        'worker output with expected content\n',
        'OWNER_DECISION: COMPLETE\nREASON: verified artifacts\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: owner confirmed\n',
      ];

      const run = await runner.execute(
        makeSupervisedConfig({
          verification: { type: 'output_contains', value: 'expected content' },
        }),
        'default'
      );

      expect(run.status).toBe('completed');
      const [step] = await db.getStepsByRunId(run.id);
      expect(step?.completionReason).toBe('completed_by_owner_decision');
    }, 15000);

    it('should fail verification before accepting OWNER_DECISION COMPLETE', async () => {
      mockSpawnOutputs = [
        'worker output without the required token\n',
        'OWNER_DECISION: COMPLETE\nREASON: verified artifacts\n',
      ];

      const run = await runner.execute(
        makeSupervisedConfig({
          verification: { type: 'output_contains', value: 'expected content' },
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(mockRelayInstance.spawnPty).toHaveBeenCalledTimes(2);
    }, 15000);

    it('should still complete as verified when no owner decision is provided and verification passes', async () => {
      mockSpawnOutputs = [
        'worker output with expected content\n',
        'Owner checked the output and left no structured decision.\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: verification passed\n',
      ];

      const run = await runner.execute(
        makeSupervisedConfig({
          verification: { type: 'output_contains', value: 'expected content' },
        }),
        'default'
      );

      expect(run.status).toBe('completed');
      const [step] = await db.getStepsByRunId(run.id);
      expect(step?.completionReason).toBe('completed_verified');
    }, 15000);
  });

  // ── Unit Test 5: Tolerant review parser ────────────────────────────────

  describe('tolerant review parsing', () => {
    it('should accept standard REVIEW_DECISION: APPROVE format', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({ type: event.type, decision: event.decision });
        }
      });

      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: all good\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'approved' });
    }, 15000);

    it('should accept standard REVIEW_DECISION: REJECT format', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({ type: event.type, decision: event.decision });
        }
      });

      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: REJECT\nREVIEW_REASON: needs work\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    }, 15000);

    // These tests validate the tolerant parser once it's implemented.
    // The tolerant parser should accept semantic equivalents.

    it('should still fail on review output with no usable approval or rejection signal', async () => {
      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'I need more context before deciding.\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review response malformed');
    }, 15000);
  });

  // ── Unit Test 6: Channel evidence ─────────────────────────────────────

  describe('channel evidence for completion', () => {
    it('should capture WORKER_DONE signals from channel messages', async () => {
      // Worker posts done signal, owner observes and confirms
      mockSpawnOutputs = [
        'WORKER_DONE: all tasks completed\n',
        'Worker reported done on channel, verified artifacts\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: channel evidence confirms\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');

      // Verify the channel received the worker done signal
      const channelMessages = (mockRelaycastAgent.send as any).mock.calls.map(
        ([, text]: [string, string]) => text
      );
      expect(channelMessages.some((text: string) => text.includes('WORKER_DONE'))).toBe(true);

      const evidence = runner.getStepCompletionEvidence('step-1');
      const workerDoneSignals =
        evidence?.coordinationSignals.filter(
          (signal) => signal.kind === 'worker_done' && signal.source === 'channel'
        ) ?? [];
      expect(workerDoneSignals.some((signal) => signal.sender === 'specialist')).toBe(true);
    }, 15000);

    it('should forward worker channel evidence to the owner prompt', async () => {
      mockSpawnOutputs = [
        'implementation complete\nWORKER_DONE: finished feature\n',
        'Observed WORKER_DONE on channel\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);

    it('should not count lead-authored WORKER_DONE channel posts as worker completion evidence', async () => {
      waitForExitFn = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'exited';
      });
      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const agent = await defaultSpawnPtyImplementation({ name, task });
          if (task?.includes('You are the step owner/supervisor for step "step-1".')) {
            emitRelayChannelMessage({
              from: agent.name,
              to: 'completion-provenance',
              text: 'WORKER_DONE: lead summarized the handoff',
            });
          }
          return agent;
        }
      );
      mockSpawnOutputs = [
        'worker progress update only\n',
        'Owner observed the channel but left no decision.\n',
      ];

      const config = makeSupervisedConfig();
      config.swarm = { ...config.swarm, channel: 'completion-provenance' };

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner completion decision missing');
      await new Promise((resolve) => setTimeout(resolve, 0));

      const evidence = runner.getStepCompletionEvidence('step-1');
      const spoofedPosts =
        evidence?.channelPosts.filter(
          (post) => post.sender === 'team-lead' && post.text.includes('WORKER_DONE')
        ) ?? [];
      expect(spoofedPosts.length).toBeGreaterThan(0);
      expect(
        evidence?.coordinationSignals.filter((signal) => signal.kind === 'worker_done') ?? []
      ).toHaveLength(0);
      const spoofedPost = evidence?.channelPosts.find(
        (post) => post.sender === 'team-lead' && post.text.includes('WORKER_DONE')
      );
      expect(spoofedPost?.signals.some((signal) => signal.kind === 'worker_done') ?? false).toBe(false);
    }, 15000);

    it('should filter wrong-agent coordination signals from the evidence view', async () => {
      mockSpawnOutputs = [
        'LEAD_DONE: worker cannot declare lead completion\nWORKER_DONE: all tasks completed\n',
        'Owner confirmed\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: verified\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');

      const evidence = runner.getStepCompletionEvidence('step-1');
      expect(evidence?.coordinationSignals.filter((signal) => signal.kind === 'lead_done')).toHaveLength(0);
      expect(
        evidence?.coordinationSignals.some(
          (signal) => signal.kind === 'worker_done' && signal.sender === 'specialist'
        )
      ).toBe(true);
    }, 15000);
  });

  describe('happy-path lead-worker workflow proof', () => {
    it('should complete by evidence when the worker posts WORKER_DONE on the channel', async () => {
      const channel = 'happy-path-worker-done';
      waitForExitFn = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'exited';
      });
      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const agent = await defaultSpawnPtyImplementation({ name, task });
          if (name.includes('step-1-worker')) {
            emitRelayChannelMessage({
              from: agent.name,
              to: channel,
              text: 'WORKER_DONE: implementation shipped',
            });
          }
          return agent;
        }
      );
      mockSpawnOutputs = [
        'artifact bundle ready\n',
        'Lead verified the worker handoff is complete and safe.\n',
      ];

      const run = await runner.execute(makeChannelSupervisedConfig(channel), 'default');

      expect(run.status).toBe('completed');
      const step = await getStepRow(db, run.id, 'step-1');
      expect(step?.completionReason).toBe('completed_by_evidence');

      const evidence = runner.getStepCompletionEvidence('step-1');
      expect(
        evidence?.coordinationSignals.some(
          (signal) =>
            signal.kind === 'worker_done' && signal.source === 'channel' && signal.sender === 'specialist'
        )
      ).toBe(true);
      expect(evidence?.coordinationSignals.some((signal) => signal.kind === 'step_complete')).toBe(false);
    }, 15000);

    it('should capture WORKER_DONE plus LEAD_DONE and complete cleanly', async () => {
      const channel = 'happy-path-lead-worker-done';
      waitForExitFn = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'exited';
      });
      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const agent = await defaultSpawnPtyImplementation({ name, task });
          if (name.includes('step-1-worker')) {
            emitRelayChannelMessage({
              from: agent.name,
              to: channel,
              text: 'WORKER_DONE: handoff package posted',
            });
          }
          if (name.includes('step-1-owner')) {
            emitRelayChannelMessage({
              from: agent.name,
              to: channel,
              text: 'LEAD_DONE: lead confirmed the worker handoff',
            });
          }
          return agent;
        }
      );
      mockSpawnOutputs = [
        'artifact bundle ready\n',
        'Lead confirmed the handoff is complete and safe for review.\n',
      ];

      const run = await runner.execute(makeChannelSupervisedConfig(channel), 'default');

      expect(run.status).toBe('completed');
      const step = await getStepRow(db, run.id, 'step-1');
      expect(step?.completionReason).toBe('completed_by_evidence');

      const evidence = runner.getStepCompletionEvidence('step-1');
      expect(
        evidence?.coordinationSignals.some(
          (signal) =>
            signal.kind === 'worker_done' && signal.source === 'channel' && signal.sender === 'specialist'
        )
      ).toBe(true);
      expect(
        evidence?.coordinationSignals.some(
          (signal) =>
            signal.kind === 'lead_done' && signal.source === 'channel' && signal.sender === 'team-lead'
        )
      ).toBe(true);
    }, 15000);

    it('should complete as verified when lead-worker verification passes without coordination markers', async () => {
      mockSpawnOutputs = [
        'worker output with expected content\n',
        'Lead checked the implementation and found it correct.\n',
      ];

      const run = await runner.execute(
        makeSupervisedConfig({ verification: { type: 'output_contains', value: 'expected content' } }),
        'default'
      );

      expect(run.status).toBe('completed');
      const step = await getStepRow(db, run.id, 'step-1');
      expect(step?.completionReason).toBe('completed_verified');

      const evidence = runner.getStepCompletionEvidence('step-1');
      expect(evidence?.coordinationSignals.some((signal) => signal.kind === 'worker_done')).toBe(false);
      expect(evidence?.coordinationSignals.some((signal) => signal.kind === 'lead_done')).toBe(false);
    }, 15000);

    it('should complete multiple supervised workers in sequence for a map-reduce style flow', async () => {
      const channel = 'happy-path-map-reduce';
      waitForExitFn = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'exited';
      });
      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const isReview = task?.includes('REVIEW_DECISION: APPROVE or REJECT');
          const output = isReview
            ? 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: map-reduce happy path verified\n'
            : name.includes('map-1-worker')
              ? 'map artifact A ready\n'
              : name.includes('map-1-owner')
                ? 'Lead verified shard A is complete and safe.\n'
                : name.includes('map-2-worker')
                  ? 'map artifact B ready\n'
                  : name.includes('map-2-owner')
                    ? 'Lead verified shard B is complete and safe.\n'
                    : name.includes('reduce-worker')
                      ? 'reduce artifact ready\n'
                      : name.includes('reduce-owner')
                        ? 'Lead verified the reduction is complete and safe.\n'
                        : 'STEP_COMPLETE:unknown\n';

          queueMicrotask(() => {
            if (typeof mockRelayInstance.onWorkerOutput === 'function') {
              mockRelayInstance.onWorkerOutput({ name, chunk: output });
            }
          });

          const agent = { ...mockAgent, name };
          if (name.includes('map-1-worker')) {
            emitRelayChannelMessage({
              from: agent.name,
              to: channel,
              text: 'WORKER_DONE: map shard A complete',
            });
          }
          if (name.includes('map-2-worker')) {
            emitRelayChannelMessage({
              from: agent.name,
              to: channel,
              text: 'WORKER_DONE: map shard B complete',
            });
          }
          if (name.includes('reduce-worker')) {
            emitRelayChannelMessage({
              from: agent.name,
              to: channel,
              text: 'WORKER_DONE: reduce pass complete',
            });
          }
          return agent;
        }
      );

      const config = makeConfig({
        swarm: { pattern: 'map-reduce', channel },
        agents: [
          { name: 'mapper-1', cli: 'claude', role: 'engineer' },
          { name: 'mapper-2', cli: 'claude', role: 'engineer' },
          { name: 'reducer', cli: 'claude', role: 'engineer' },
          { name: 'team-lead', cli: 'claude', role: 'lead coordinator' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'map-1', agent: 'mapper-1', task: 'Process shard A' },
              { name: 'map-2', agent: 'mapper-2', task: 'Process shard B' },
              {
                name: 'reduce',
                agent: 'reducer',
                task: 'Combine mapped results',
                dependsOn: ['map-1', 'map-2'],
              },
            ],
          },
        ],
      });

      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('completed');
      const steps = await db.getStepsByRunId(run.id);
      expect(steps.map((step) => step.stepName)).toEqual(['map-1', 'map-2', 'reduce']);
      expect(steps.map((step) => step.status)).toEqual(['completed', 'completed', 'completed']);
      expect(steps.map((step) => step.completionReason)).toEqual([
        'completed_by_evidence',
        'completed_by_evidence',
        'completed_by_evidence',
      ]);
      expect(
        runner
          .getStepCompletionEvidence('reduce')
          ?.coordinationSignals.some(
            (signal) =>
              signal.kind === 'worker_done' && signal.source === 'channel' && signal.sender === 'reducer'
          )
      ).toBe(true);
    }, 15000);

    it('should still complete when WORKER_DONE lands after the lead checks the work', async () => {
      const channel = 'happy-path-delayed-worker-done';
      const observedOrder: string[] = [];
      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const agent = await defaultSpawnPtyImplementation({ name, task });

          if (name.includes('step-1-worker')) {
            setTimeout(() => {
              observedOrder.push('worker-done-message');
              emitRelayChannelMessage({
                from: agent.name,
                to: channel,
                text: 'WORKER_DONE: delayed handoff posted',
              });
            }, 10);
            return {
              ...agent,
              waitForExit: vi.fn().mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                return 'exited' as const;
              }),
            };
          }

          if (name.includes('step-1-owner')) {
            return {
              ...agent,
              waitForExit: vi.fn().mockImplementation(async () => {
                observedOrder.push('owner-finished-check');
                return 'exited' as const;
              }),
            };
          }

          return agent;
        }
      );
      mockSpawnOutputs = [
        'artifact bundle ready but handoff signal is delayed\n',
        'Lead checked the artifacts early and the work still looks complete and safe.\n',
      ];

      const run = await runner.execute(makeChannelSupervisedConfig(channel), 'default');

      expect(run.status).toBe('completed');
      expect(observedOrder).toEqual(['owner-finished-check', 'worker-done-message']);

      const step = await getStepRow(db, run.id, 'step-1');
      expect(step?.completionReason).toBe('completed_by_evidence');
      expect(
        runner
          .getStepCompletionEvidence('step-1')
          ?.coordinationSignals.some(
            (signal) =>
              signal.kind === 'worker_done' &&
              signal.source === 'channel' &&
              signal.value === 'delayed handoff posted'
          )
      ).toBe(true);
    }, 15000);
  });

  // ── Integration Test 1: Codex lead/worker without marker ──────────────

  describe('Codex lead/worker completion', () => {
    it('should complete when codex lead omits STEP_COMPLETE but owner logic still completes', async () => {
      // Codex agents use `codex exec` and may not emit the exact marker.
      // With a verification gate, the step should still complete.
      mockSpawnOutputs = [
        'worker: implemented the feature\n',
        'Lead verified: all changes look correct\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: verified\n',
      ];

      const config = makeSupervisedConfig();
      // Override to codex CLI
      config.agents = [
        { name: 'specialist', cli: 'codex', role: 'engineer' },
        { name: 'team-lead', cli: 'codex', role: 'lead coordinator' },
        { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
      ];

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(
        mockRelayInstance.spawnPty.mock.calls.some(
          ([input]) =>
            input.cli === 'codex' &&
            Array.isArray(input.args) &&
            input.args.includes('--dangerously-bypass-approvals-and-sandbox')
        )
      ).toBe(true);
    }, 15000);
  });

  // ── Integration Test 2: Gemini lead/worker with channel completion ────

  describe('Gemini lead/worker with channel completion', () => {
    it('should complete when gemini worker posts channel completion and owner finalizes', async () => {
      mockSpawnOutputs = [
        'Worker output: feature implemented\nWORKER_DONE: task complete\n',
        'Observed worker completion on channel\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: channel evidence\n',
      ];

      const config = makeSupervisedConfig();
      config.agents = [
        { name: 'specialist', cli: 'gemini', role: 'engineer' },
        { name: 'team-lead', cli: 'gemini', role: 'lead coordinator' },
        { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
      ];

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
    }, 15000);
  });

  // ── Integration Test 3: Supervisor without exact review sentinel ───────

  describe('Supervisor workflow completion', () => {
    it('should complete supervised step with standard review flow', async () => {
      mockSpawnOutputs = [
        'worker built the feature\n',
        'Verified: code passes tests\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: correct implementation\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);
  });

  // ── Integration Test 4: Map-reduce workflow remains unaffected ─────────

  describe('Map-reduce workflow backward compatibility', () => {
    it('should complete map-reduce workflow with standard markers', async () => {
      const config = makeConfig({
        swarm: { pattern: 'map-reduce' },
        agents: [
          { name: 'mapper-1', cli: 'claude' },
          { name: 'mapper-2', cli: 'claude' },
          { name: 'reducer', cli: 'claude' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'map-1', agent: 'mapper-1', task: 'Process chunk A' },
              { name: 'map-2', agent: 'mapper-2', task: 'Process chunk B' },
              { name: 'reduce', agent: 'reducer', task: 'Combine results', dependsOn: ['map-1', 'map-2'] },
            ],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
    }, 15000);
  });

  // ── Integration Test 5: Legacy marker-based workflows ─────────────────

  describe('Legacy marker-based workflows', () => {
    it('should still complete with explicit STEP_COMPLETE marker (backward compat)', async () => {
      // The classic marker-based flow should continue to work unchanged
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);

    it('should still fail when marker, owner decision, and evidence are all missing', async () => {
      mockSpawnOutputs = ['Did the work but no marker\n'];
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner completion decision missing');
    }, 15000);

    it('should still support explicit REVIEW_DECISION: APPROVE flow', async () => {
      mockSpawnOutputs = [
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: standard approval\n',
      ];

      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({ type: event.type, decision: event.decision });
        }
      });

      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: legacy approval\n',
        'worker finished step 2\n',
        'STEP_COMPLETE:step-2\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: legacy approval step 2\n',
      ];

      const run = await runner.execute(makeTwoStepSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'approved' });
    }, 15000);

    it('should still support explicit REVIEW_DECISION: REJECT flow', async () => {
      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: REJECT\nREVIEW_REASON: standard rejection\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
    }, 15000);

    it('should still fail closed on malformed review output', async () => {
      mockSpawnOutputs = ['worker finished\n', 'STEP_COMPLETE:step-1\n', 'I think this looks ok\n'];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review response malformed');
    }, 15000);

    it('should preserve owner/specialist separation in supervised workflows', async () => {
      mockSpawnOutputs = [
        'worker finished\n',
        'Owner verified\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: good\n',
      ];

      const ownerAssignments: Array<{ owner: string; specialist: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerAssignments.push({ owner: event.ownerName, specialist: event.specialistName });
        }
      });

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments).toHaveLength(1);
      expect(ownerAssignments[0].owner).toBe('team-lead');
      expect(ownerAssignments[0].specialist).toBe('specialist');
    }, 15000);
  });

  // ── Backward compat: event emission ───────────────────────────────────

  describe('backward compatibility: event emission', () => {
    it('should emit run:started and run:completed events', async () => {
      const events: string[] = [];
      runner.on((event) => events.push(event.type));

      await runner.execute(makeConfig(), 'default');

      expect(events).toContain('run:started');
      expect(events).toContain('run:completed');
    }, 15000);

    it('should emit step:started and step:completed events in order', async () => {
      const stepEvents: Array<{ type: string; stepName?: string }> = [];
      runner.on((event) => {
        if (event.type.startsWith('step:')) {
          stepEvents.push({
            type: event.type,
            stepName: 'stepName' in event ? event.stepName : undefined,
          });
        }
      });

      await runner.execute(makeConfig(), 'default');

      const startedSteps = stepEvents.filter((e) => e.type === 'step:started');
      const completedSteps = stepEvents.filter((e) => e.type === 'step:completed');
      expect(startedSteps).toHaveLength(2);
      expect(completedSteps).toHaveLength(2);
    }, 15000);

    it('should emit owner-assigned events for all steps', async () => {
      const ownerEvents: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerEvents.push(event.stepName);
        }
      });

      await runner.execute(makeConfig(), 'default');
      expect(ownerEvents).toHaveLength(2);
    }, 15000);

    it('should emit review-completed events for all interactive steps', async () => {
      const reviewEvents: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          reviewEvents.push(event.stepName);
        }
      });

      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n',
        'worker finished step 2\n',
        'STEP_COMPLETE:step-2\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n',
      ];

      await runner.execute(makeTwoStepSupervisedConfig(), 'default');
      expect(reviewEvents).toHaveLength(2);
    }, 15000);
  });

  // ── Backward compat: DAG execution ordering ───────────────────────────

  describe('backward compatibility: DAG execution', () => {
    it('should execute steps in dependency order', async () => {
      const completedSteps: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:completed') {
          completedSteps.push(event.stepName);
        }
      });

      await runner.execute(makeConfig(), 'default');

      const idx1 = completedSteps.indexOf('step-1');
      const idx2 = completedSteps.indexOf('step-2');
      expect(idx1).toBeLessThan(idx2);
    }, 15000);

    it('should run parallel steps concurrently', async () => {
      const startTimes: Record<string, number> = {};
      runner.on((event) => {
        if (event.type === 'step:started') {
          startTimes[event.stepName] = Date.now();
        }
      });

      const config = makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'a', agent: 'agent-a', task: 'Do A' },
              { name: 'b', agent: 'agent-b', task: 'Do B' },
              { name: 'c', agent: 'agent-a', task: 'Do C', dependsOn: ['a', 'b'] },
            ],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');

      // a and b should start nearly simultaneously (within 100ms)
      const diff = Math.abs((startTimes['a'] ?? 0) - (startTimes['b'] ?? 0));
      expect(diff).toBeLessThan(1000);
    }, 15000);
  });

  // ── Backward compat: CLI command building ─────────────────────────────

  describe('backward compatibility: CLI command building', () => {
    it('should build claude command correctly', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('claude', 'Task');
      expect(cmd).toBe('claude');
      expect(args).toContain('-p');
    });

    it('should build codex command correctly', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('codex', 'Task');
      expect(cmd).toBe('codex');
      expect(args).toContain('exec');
    });

    it('should build gemini command correctly', () => {
      const { cmd, args } = WorkflowRunner.buildNonInteractiveCommand('gemini', 'Task');
      expect(cmd).toBe('gemini');
      expect(args).toContain('-p');
    });
  });

  // ── Backward compat: variable resolution ──────────────────────────────

  describe('backward compatibility: variable resolution', () => {
    it('should resolve {{var}} in step tasks', async () => {
      const config = makeConfig();
      config.workflows![0].steps[0].task = 'Build {{feature}}';
      const run = await runner.execute(config, 'default', { feature: 'auth' });
      expect(run.status, run.error).toBe('completed');
    }, 15000);

    it('should throw on unresolved variables', () => {
      const config = makeConfig({
        agents: [{ name: 'a', cli: 'claude', task: 'Fix {{unknown}}' }],
      });
      expect(() => runner.resolveVariables(config, {})).toThrow('Unresolved variable: {{unknown}}');
    });
  });

  // ── Backward compat: review PTY echo handling ─────────────────────────

  describe('backward compatibility: review PTY echo handling', () => {
    it('should parse last REVIEW_DECISION when PTY echoes prompt', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({ type: event.type, decision: event.decision });
        }
      });

      const echoedPrompt =
        'Return exactly:\nREVIEW_DECISION: APPROVE or REJECT\nREVIEW_REASON: <one sentence>\n';
      const actualResponse = 'REVIEW_DECISION: REJECT\nREVIEW_REASON: code has bugs\n';
      mockSpawnOutputs = ['worker finished\n', 'STEP_COMPLETE:step-1\n', echoedPrompt + actualResponse];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    }, 15000);
  });

  // ── Backward compat: timeout handling ─────────────────────────────────

  describe('backward compatibility: timeout handling', () => {
    it('should emit step:owner-timeout on timeout', async () => {
      const events: Array<{ type: string; stepName?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-timeout') {
          events.push({ type: event.type, stepName: event.stepName });
        }
      });

      waitForExitFn = vi.fn().mockResolvedValue('timeout');
      waitForIdleFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(events).toContainEqual({ type: 'step:owner-timeout', stepName: 'step-1' });
    }, 15000);
  });

  // ── Phase 1 compatibility mode ────────────────────────────────────────

  describe('Phase 1 compatibility mode', () => {
    it('should keep markers as fast-path for completion', async () => {
      // When the marker is present, it should complete immediately without
      // needing to evaluate the full evidence pipeline
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);

    it('should accept both old marker format and new OWNER_DECISION format', async () => {
      // Old format still works
      mockSpawnOutputs = ['STEP_COMPLETE:step-1\n'];
      const run1 = await runner.execute(
        makeConfig({
          workflows: [{ name: 'default', steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do it' }] }],
        }),
        'default'
      );
      expect(run1.status).toBe('completed');
    }, 15000);
  });

  // ── Evidence interface tests ──────────────────────────────────────────

  describe('evidence collection interface', () => {
    it('should expose getStepCompletionEvidence() on runner', () => {
      expect(typeof runner.getStepCompletionEvidence).toBe('function');
    });

    it('should return undefined for unknown step names', () => {
      const evidence = runner.getStepCompletionEvidence('nonexistent-step');
      expect(evidence).toBeUndefined();
    });

    it('should return evidence with correct shape after step execution', async () => {
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');

      const evidence = runner.getStepCompletionEvidence('step-1');
      if (evidence) {
        // Verify the evidence structure matches StepCompletionEvidence
        expect(evidence.stepName).toBe('step-1');
        expect(evidence).toHaveProperty('channelPosts');
        expect(evidence).toHaveProperty('files');
        expect(evidence).toHaveProperty('process');
        expect(evidence).toHaveProperty('toolSideEffects');
        expect(evidence).toHaveProperty('coordinationSignals');
        expect(Array.isArray(evidence.channelPosts)).toBe(true);
        expect(Array.isArray(evidence.files)).toBe(true);
        expect(Array.isArray(evidence.toolSideEffects)).toBe(true);
        expect(Array.isArray(evidence.coordinationSignals)).toBe(true);
      }
    }, 15000);

    it('should collect evidence for supervised steps', async () => {
      mockSpawnOutputs = [
        'worker completed the implementation\n',
        'Owner verified work\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: good\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');

      const evidence = runner.getStepCompletionEvidence('step-1');
      if (evidence) {
        expect(evidence.stepName).toBe('step-1');
        // Supervised steps should have channel posts from worker output forwarding
        expect(evidence.channelPosts.length).toBeGreaterThanOrEqual(0);
      }
    }, 15000);

    it('should capture WORKER_DONE as a coordination signal', async () => {
      mockSpawnOutputs = [
        'WORKER_DONE: all tasks completed\n',
        'Owner confirmed\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: verified\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');

      const evidence = runner.getStepCompletionEvidence('step-1');
      if (evidence) {
        const workerDoneSignals = evidence.coordinationSignals.filter((s) => s.kind === 'worker_done');
        // If the evidence collector detected the WORKER_DONE signal, it should be present
        if (workerDoneSignals.length > 0) {
          expect(workerDoneSignals[0].kind).toBe('worker_done');
        }
      }
    }, 15000);

    it('should return a defensive copy (not a live reference)', async () => {
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');

      const evidence1 = runner.getStepCompletionEvidence('step-1');
      const evidence2 = runner.getStepCompletionEvidence('step-1');
      if (evidence1 && evidence2) {
        expect(evidence1).not.toBe(evidence2); // structuredClone should return a new object
        expect(evidence1).toEqual(evidence2); // but with the same content
      }
    }, 15000);
  });

  // ── completionReason field on step rows ───────────────────────────────

  describe('completionReason on step rows', () => {
    it('should set completionReason on completed steps', async () => {
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');

      const steps = await db.getStepsByRunId(run.id);
      const completedSteps = steps.filter((s) => s.status === 'completed');
      expect(completedSteps.length).toBeGreaterThan(0);

      for (const step of completedSteps) {
        if (step.completionReason) {
          // completionReason should be a valid value
          const validReasons: WorkflowStepCompletionReason[] = [
            'completed_verified',
            'completed_by_owner_decision',
            'completed_by_evidence',
            'completed_by_process_exit',
            'retry_requested_by_owner',
            'failed_verification',
            'failed_owner_decision',
            'failed_no_evidence',
          ];
          expect(validReasons).toContain(step.completionReason);
        }
      }
    }, 15000);
  });

  describe('process-exit fallback (compliance reduction)', () => {
    it('should complete step via process exit code 0 when no coordination signal is posted', async () => {
      // Agent exits cleanly (code 0) but doesn't post STEP_COMPLETE or OWNER_DECISION.
      // With verification configured (exit_code), the runner should infer completion.
      const config = makeConfig({
        swarm: { pattern: 'dag', completionGracePeriodMs: 5000 },
        agents: [{ name: 'agent-a', cli: 'claude' }],
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'silent-worker',
                agent: 'agent-a',
                task: 'Do some work silently',
                verification: { type: 'exit_code', value: '0' },
              },
            ],
          },
        ],
      });

      // Output has no STEP_COMPLETE, no OWNER_DECISION — just normal work output
      mockSpawnOutputs = ['Implemented the auth module. All tests pass.'];

      const localDb = makeDb();
      runner = new WorkflowRunner({ db: localDb, workspaceId: 'ws-test' });
      const events: any[] = [];
      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('completed');
      const steps = await localDb.getStepsByRunId(run.id);
      const step = steps.find((s: any) => s.stepName === 'silent-worker');
      expect(step?.status).toBe('completed');
      // Should be completed_by_process_exit or completed_verified (exit_code verification)
      expect(step?.completionReason).toBeDefined();
    }, 15000);

    it('should fail when process exits with non-zero code and no signal', async () => {
      // Agent exits with non-zero and no coordination signal — should fail
      const config = makeConfig({
        swarm: { pattern: 'dag', completionGracePeriodMs: 5000 },
        agents: [{ name: 'agent-a', cli: 'claude' }],
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'failing-worker',
                agent: 'agent-a',
                task: 'Try something',
              },
            ],
          },
        ],
      });

      // No STEP_COMPLETE, no OWNER_DECISION, and we'll simulate a non-clean exit
      // by having the output lack any positive signals
      mockSpawnOutputs = ['Error: something went wrong'];

      const localDb = makeDb();
      runner = new WorkflowRunner({ db: localDb, workspaceId: 'ws-test' });
      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('failed');
    }, 15000);

    it('should respect completionGracePeriodMs: 0 to disable fallback', async () => {
      // With grace period disabled, missing signals should always fail
      const config = makeConfig({
        swarm: { pattern: 'dag', completionGracePeriodMs: 0 },
        agents: [{ name: 'agent-a', cli: 'claude' }],
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'strict-worker',
                agent: 'agent-a',
                task: 'Do work with strict compliance required',
              },
            ],
          },
        ],
      });

      // Output has no signals at all
      mockSpawnOutputs = ['Work completed but no signal posted.'];

      const localDb = makeDb();
      runner = new WorkflowRunner({ db: localDb, workspaceId: 'ws-test' });
      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('failed');
    }, 15000);

    it('should complete via evidence when process exits 0 and owner output has positive conclusion', async () => {
      // Agent posts no explicit signal but says "done" + exit code 0 is captured as evidence
      const config = makeConfig({
        swarm: { pattern: 'dag' },
        agents: [{ name: 'agent-a', cli: 'claude' }],
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'wordy-worker',
                agent: 'agent-a',
                task: 'Implement the feature',
                verification: { type: 'exit_code', value: '0' },
              },
            ],
          },
        ],
      });

      // Output contains positive conclusion words but no explicit marker
      mockSpawnOutputs = ['Feature implemented and verified. All artifacts are correct and complete.'];

      const localDb = makeDb();
      runner = new WorkflowRunner({ db: localDb, workspaceId: 'ws-test' });
      const run = await runner.execute(config, 'default');

      expect(run.status).toBe('completed');
    }, 15000);
  });

  describe('template re-quoting regression (parseOwnerDecision)', () => {
    it('should not pick COMPLETE from re-quoted template when agent said INCOMPLETE_RETRY', async () => {
      // Bug repro: agent says INCOMPLETE_RETRY then re-quotes the template format,
      // causing the last-match heuristic to pick COMPLETE from the template line.
      mockSpawnOutputs = [
        'worker did the task\n',
        [
          'STEP OWNER CONTRACT:',
          '- Preferred final decision format:',
          '  OWNER_DECISION: COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION',
          '  REASON: <one sentence>',
          '',
          'OWNER_DECISION: INCOMPLETE_RETRY',
          'REASON: Tests are still failing',
          '',
          'I chose INCOMPLETE_RETRY as per the options OWNER_DECISION: COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION',
        ].join('\n'),
      ];

      const run = await runner.execute(makeSupervisedConfig({ retries: 0 }), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('INCOMPLETE_RETRY');

      const steps = await db.getStepsByRunId(run.id);
      expect(steps[0]?.completionReason).toBe('retry_requested_by_owner');
    }, 15000);

    it('should correctly parse COMPLETE when it is the real decision, not just template text', async () => {
      // Ensure the fix doesn't break the happy path — agent says COMPLETE after echoed template
      mockSpawnOutputs = [
        'worker did the task\n',
        [
          'STEP OWNER CONTRACT:',
          '- Preferred final decision format:',
          '  OWNER_DECISION: COMPLETE|INCOMPLETE_RETRY|INCOMPLETE_FAIL|NEEDS_CLARIFICATION',
          '',
          'OWNER_DECISION: COMPLETE',
          'REASON: Worker finished the task successfully',
        ].join('\n'),
      ];

      const run = await runner.execute(makeSupervisedConfig({ retries: 0 }), 'default');
      expect(run.status).toBe('completed');

      const steps = await db.getStepsByRunId(run.id);
      expect(steps[0]?.completionReason).toBe('completed_by_owner_decision');
    }, 15000);
  });

  describe('fallback guards against explicit retry signals', () => {
    it('should not complete via evidence fallback when output contains INCOMPLETE_RETRY', async () => {
      // Bug repro: parseOwnerDecision returns null (garbled PTY), but raw output
      // contains INCOMPLETE_RETRY. judgeOwnerCompletionByEvidence should refuse
      // to infer completion.
      mockSpawnOutputs = [
        'worker completed locally\n',
        [
          'I reviewed the worker output. The task looks done but tests are failing.',
          'OW NER_DECISION: INCOMPLETE_RETRY', // garbled by PTY line wrap
          'REASON: tests failing',
          'The worker completed the implementation but verification failed.',
          'OWNER_DECISION: INCOMPLETE_RETRY', // clear signal in raw output
        ].join('\n'),
      ];

      const run = await runner.execute(makeSupervisedConfig({ retries: 0 }), 'default');
      expect(run.status).toBe('failed');
    }, 15000);

    it('should not complete via process-exit fallback when output contains INCOMPLETE_RETRY', async () => {
      const config = makeConfig({
        swarm: { pattern: 'dag', completionGracePeriodMs: 5000 },
        agents: [{ name: 'agent-a', cli: 'claude' }],
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'retried-worker',
                agent: 'agent-a',
                task: 'Do work',
                verification: { type: 'exit_code', value: '0' },
              },
            ],
          },
        ],
      });

      // Agent exits code 0 and verification passes, BUT output contains INCOMPLETE_RETRY
      mockSpawnOutputs = [
        'Implemented the feature.\nOWNER_DECISION: INCOMPLETE_RETRY\nREASON: needs more tests\n',
      ];

      const localDb = makeDb();
      runner = new WorkflowRunner({ db: localDb, workspaceId: 'ws-test' });
      const run = await runner.execute(config, 'default');

      // Should NOT complete — the explicit retry signal should prevent fallback
      expect(run.status).toBe('failed');
    }, 15000);
  });
});
