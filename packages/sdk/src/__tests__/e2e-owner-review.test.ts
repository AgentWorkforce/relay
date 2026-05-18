/**
 * E2E test harness for PR #511: auto step owner + per-step review gating.
 *
 * Validates:
 * 1. Hub-role agent auto-assigned as owner (lead matches)
 * 2. "github-integration" agent NOT matched as hub (word-boundary)
 * 3. Review gating — approval flow
 * 4. Review gating — rejection flow (PTY echo handling)
 * 5. Review timeout budgeting
 * 6. Owner timeout emission
 * 7. Lead + workers team with owner assignment
 * 8. YAML workflow parsing of e2e-owner-review.yaml
 * 9. Owner completion marker validation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WorkflowDb } from '../workflows/runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../workflows/types.js';

// ── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { api_key: 'rk_live_test', workspace_id: 'ws-test' } }),
  text: () => Promise.resolve(''),
});
vi.stubGlobal('fetch', mockFetch);

// ── Mock RelayCast SDK ──────────────────────────────────────────────────────

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
  agents: { register: vi.fn().mockResolvedValue({ token: 'token-1' }) },
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

// ── Mock AgentRelay ─────────────────────────────────────────────────────────

let waitForExitFn: (ms?: number) => Promise<'exited' | 'timeout' | 'released'>;
let waitForIdleFn: (ms?: number) => Promise<'idle' | 'timeout' | 'exited'>;
let mockSpawnOutputs: string[] = [];

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
  listAgentsRaw: vi.fn().mockResolvedValue([]),
};

vi.mock('../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

// Import after mocking
const { WorkflowRunner } = await import('../workflows/runner.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

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
    name: 'e2e-owner-review-test',
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

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

type WorkflowStepOverride = Partial<NonNullable<RelayYamlConfig['workflows']>[number]['steps'][number]>;

function makeSupervisedConfig(stepOverrides: WorkflowStepOverride = {}): RelayYamlConfig {
  return makeConfig({
    swarm: { pattern: 'hub-spoke' },
    agents: [
      { name: 'specialist', cli: 'claude', role: 'engineer' },
      { name: 'team-lead', cli: 'claude', role: 'Lead coordinator for the workflow' },
      { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-1', agent: 'specialist', task: 'Implement the requested change', ...stepOverrides },
        ],
      },
    ],
  });
}

// ── E2E Scenarios ───────────────────────────────────────────────────────────

describe('PR #511 E2E: Auto Step Owner + Review Gating', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;

  beforeEach(() => {
    vi.clearAllMocks();
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    waitForIdleFn = vi.fn().mockImplementation(() => never());
    mockSpawnOutputs = [];
    mockAgent.release.mockResolvedValue(undefined);
    mockRelayInstance.spawnPty.mockImplementation(defaultSpawnPtyImplementation);
    mockRelayInstance.onWorkerOutput = null;
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });
  });

  // ── Scenario 1: Hub-role agent auto-assigned as owner ───────────────────

  describe('Scenario 1: Hub-role auto-ownership', () => {
    it('should auto-assign lead agent as owner for specialist steps', async () => {
      const ownerAssignments: Array<{ owner: string; specialist: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerAssignments.push({ owner: event.ownerName, specialist: event.specialistName });
        }
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'impl-worker', cli: 'claude', role: 'implementer' },
          { name: 'team-lead', cli: 'claude', role: 'Lead coordinator for the workflow' },
          { name: 'quality-reviewer', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'hub-owner-test', agent: 'impl-worker', task: 'List 3 benefits' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments).toHaveLength(1);
      expect(ownerAssignments[0].owner).toBe('team-lead');
      expect(ownerAssignments[0].specialist).toBe('impl-worker');
    }, 15000);

    it('should prioritize lead over coordinator in owner resolution', async () => {
      const ownerAssignments: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') ownerAssignments.push(event.ownerName);
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'coord-bot', cli: 'claude', role: 'coordinator' },
          { name: 'lead-bot', cli: 'claude', role: 'lead' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'step-1', agent: 'specialist', task: 'Do work' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments[0]).toBe('lead-bot');
    }, 15000);

    it('should spawn a separate worker and supervisor for dedicated owner steps', async () => {
      mockSpawnOutputs = [
        'worker finished\n',
        'Observed progress on channel\nSTEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');

      const spawnCalls = (mockRelayInstance.spawnPty as any).mock.calls;
      expect(spawnCalls[0][0].name).toContain('step-1-worker');
      expect(spawnCalls[1][0].name).toContain('step-1-owner');
      expect(spawnCalls[0][0].task).not.toContain('STEP_COMPLETE:step-1');
      expect(spawnCalls[1][0].task).toContain('You are the step owner/supervisor for step "step-1".');
    }, 15000);
  });

  // ── Scenario 2: github-integration NOT matched as hub ───────────────────

  describe('Scenario 2: Hub word-boundary matching', () => {
    it('should NOT match "github-integration" as hub-role agent', async () => {
      const ownerAssignments: Array<{ owner: string; specialist: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerAssignments.push({ owner: event.ownerName, specialist: event.specialistName });
        }
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'github-integration', cli: 'claude', role: 'GitHub integration agent' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'github-no-hub', agent: 'specialist', task: 'Test word boundary' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments[0].owner).not.toBe('github-integration');
      expect(ownerAssignments[0].owner).toBe('specialist');
    }, 15000);

    it('should NOT match "github-bot" with role "github integration" as hub', async () => {
      const ownerAssignments: Array<{ owner: string; specialist: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerAssignments.push({ owner: event.ownerName, specialist: event.specialistName });
        }
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'github-bot', cli: 'claude', role: 'github integration' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [{ name: 'step-1', agent: 'specialist', task: 'Do work' }],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments[0].owner).not.toBe('github-bot');
      expect(ownerAssignments[0].owner).toBe('specialist');
    }, 15000);
  });

  // ── Scenario 3: Review gating — approval flow ──────────────────────────

  describe('Scenario 3: Review gating approval', () => {
    it('should emit step:review-completed with approved decision', async () => {
      const reviewEvents: Array<{ decision: string; reviewerName: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          reviewEvents.push({ decision: event.decision, reviewerName: event.reviewerName });
        }
      });

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
      expect(reviewEvents.length).toBeGreaterThanOrEqual(1);
      expect(reviewEvents[0].decision).toBe('approved');
    }, 15000);

    it('should gate step completion on review approval', async () => {
      const stepEvents: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:completed' || event.type === 'step:review-completed') {
          stepEvents.push(event.type);
        }
      });

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('completed');
      const reviewIdx = stepEvents.indexOf('step:review-completed');
      const completedIdx = stepEvents.indexOf('step:completed');
      expect(reviewIdx).toBeGreaterThanOrEqual(0);
      expect(reviewIdx).toBeLessThan(completedIdx);
    }, 15000);

    it('should complete review from streamed REVIEW_DECISION before normal exit', async () => {
      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const isReview = task?.includes('REVIEW_DECISION: APPROVE or REJECT');
          const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/)?.[1]?.trim();
          const output = isReview
            ? 'REVIEW_DECISION: APPROVE\nREVIEW_REASON: streamed completion\n'
            : stepComplete
              ? `STEP_COMPLETE:${stepComplete}\n`
              : 'STEP_COMPLETE:unknown\n';

          queueMicrotask(() => {
            if (typeof mockRelayInstance.onWorkerOutput === 'function') {
              mockRelayInstance.onWorkerOutput({ name, chunk: output });
            }
          });

          if (!isReview) {
            return { ...mockAgent, name };
          }

          let released = false;
          let resolveExit: ((result: 'released') => void) | undefined;
          const waitForExit = vi.fn().mockImplementation(() => {
            if (released) {
              return Promise.resolve<'released'>('released');
            }
            return new Promise<'released'>((resolve) => {
              resolveExit = resolve;
            });
          });
          const release = vi.fn().mockImplementation(async () => {
            released = true;
            resolveExit?.('released');
          });

          return {
            name,
            waitForExit,
            waitForIdle: vi.fn().mockImplementation(() => never()),
            release,
          };
        }
      );

      const run = await runner.execute(makeSupervisedConfig(), 'default');

      expect(run.status).toBe('completed');
      const spawnResults = (mockRelayInstance.spawnPty as any).mock.results;
      const reviewAgent = await spawnResults[spawnResults.length - 1].value;
      expect(reviewAgent.name).toContain('step-1-review');
      expect(reviewAgent.release).toHaveBeenCalledTimes(1);
    }, 15000);

    it('should mirror worker output to the channel for owner observation', async () => {
      mockSpawnOutputs = [
        'worker progress update\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: APPROVE\nREVIEW_REASON: looks good\n',
      ];

      const run = await runner.execute(
        makeSupervisedConfig({ verification: { type: 'output_contains', value: 'worker progress update' } }),
        'default'
      );
      expect(run.status).toBe('completed');

      const channelMessages = (mockRelaycastAgent.send as any).mock.calls.map(
        ([, text]: [string, string]) => text
      );
      expect(channelMessages.some((text: string) => text.includes('worker progress update'))).toBe(true);
      expect(channelMessages.some((text: string) => text.includes('Worker `step-1-worker'))).toBe(true);
    }, 15000);
  });

  // ── Scenario 4: Review gating — rejection flow ─────────────────────────

  describe('Scenario 4: Review gating rejection', () => {
    it('should fail the step when reviewer rejects', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({ type: event.type, decision: event.decision });
        }
      });

      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: REJECT\nREVIEW_REASON: output is incomplete\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    }, 15000);

    it('should fail closed when review output is malformed (no REVIEW_DECISION)', async () => {
      mockSpawnOutputs = [
        'worker finished\n',
        'STEP_COMPLETE:step-1\n',
        'REVIEW_REASON: this is missing the decision line\n',
      ];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review response malformed');
    }, 15000);

    it('should use last REVIEW_DECISION match when PTY echoes prompt (reject)', async () => {
      const events: Array<{ type: string; decision?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:review-completed') {
          events.push({ type: event.type, decision: event.decision });
        }
      });

      const echoedPrompt =
        'Return exactly:\nREVIEW_DECISION: APPROVE or REJECT\nREVIEW_REASON: <one sentence>\n';
      const actualResponse = 'REVIEW_DECISION: REJECT\nREVIEW_REASON: code has critical bugs\n';
      mockSpawnOutputs = ['worker finished\n', 'STEP_COMPLETE:step-1\n', echoedPrompt + actualResponse];

      const run = await runner.execute(makeSupervisedConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    }, 15000);
  });

  // ── Scenario 5: Review timeout budgeting ───────────────────────────────

  describe('Scenario 5: Review timeout budgeting', () => {
    it('should use the full remaining step timeout as the review safety backstop', async () => {
      const config = makeSupervisedConfig({ timeoutMs: 90_000 });

      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const isReview = task?.includes('REVIEW_DECISION: APPROVE or REJECT');
          const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/)?.[1]?.trim();
          const output = isReview
            ? ''
            : stepComplete
              ? `STEP_COMPLETE:${stepComplete}\n`
              : 'worker finished\n';

          if (output) {
            queueMicrotask(() => {
              if (typeof mockRelayInstance.onWorkerOutput === 'function') {
                mockRelayInstance.onWorkerOutput({ name, chunk: output });
              }
            });
          }

          return {
            name,
            waitForExit: vi.fn().mockResolvedValue(isReview ? 'timeout' : 'exited'),
            waitForIdle: vi.fn().mockImplementation(() => never()),
            release: vi.fn().mockResolvedValue(undefined),
          };
        }
      );

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review safety backstop timed out');

      const spawnResults = (mockRelayInstance.spawnPty as any).mock.results;
      const reviewAgent = await spawnResults[spawnResults.length - 1].value;
      const reviewTimeout = reviewAgent.waitForExit.mock.calls[0][0];
      expect(reviewTimeout).toBeGreaterThan(60_000);
      expect(reviewTimeout).toBeLessThanOrEqual(90_000);
    }, 15000);

    it('should default the review safety backstop to 10 minutes when no step timeout is set', async () => {
      const config = makeSupervisedConfig();

      mockRelayInstance.spawnPty.mockImplementation(
        async ({ name, task }: { name: string; task?: string }) => {
          const isReview = task?.includes('REVIEW_DECISION: APPROVE or REJECT');
          const stepComplete = task?.match(/STEP_COMPLETE:([^\n]+)/)?.[1]?.trim();
          const output = isReview
            ? ''
            : stepComplete
              ? `STEP_COMPLETE:${stepComplete}\n`
              : 'worker finished\n';

          if (output) {
            queueMicrotask(() => {
              if (typeof mockRelayInstance.onWorkerOutput === 'function') {
                mockRelayInstance.onWorkerOutput({ name, chunk: output });
              }
            });
          }

          return {
            name,
            waitForExit: vi.fn().mockResolvedValue(isReview ? 'timeout' : 'exited'),
            waitForIdle: vi.fn().mockImplementation(() => never()),
            release: vi.fn().mockResolvedValue(undefined),
          };
        }
      );

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review safety backstop timed out after 600000ms');

      const spawnResults = (mockRelayInstance.spawnPty as any).mock.results;
      const reviewAgent = await spawnResults[spawnResults.length - 1].value;
      expect(reviewAgent.waitForExit).toHaveBeenCalledWith(600_000);
    }, 15000);
  });

  // ── Scenario 6: Owner timeout emission ─────────────────────────────────

  describe('Scenario 6: Owner timeout events', () => {
    it('should emit step:owner-timeout when owner exceeds time limit', async () => {
      const events: Array<{ type: string; stepName?: string; ownerName?: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-timeout') {
          events.push({ type: event.type, stepName: event.stepName, ownerName: event.ownerName });
        }
      });

      waitForExitFn = vi.fn().mockResolvedValue('timeout');
      waitForIdleFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('timed out');
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].type).toBe('step:owner-timeout');
      expect(events[0].stepName).toBe('step-1');
    }, 15000);

    it('should NOT emit step:owner-timeout for successful reviews', async () => {
      const ownerTimeouts: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:owner-timeout') ownerTimeouts.push(event.stepName);
      });

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');
      expect(ownerTimeouts).toHaveLength(0);
    }, 15000);
  });

  // ── Scenario 7: Multi-agent team with owner assignment ─────────────────

  describe('Scenario 7: Lead + workers team pattern', () => {
    it('should assign lead as owner for worker steps in a team', async () => {
      const ownerAssignments: Array<{ owner: string; specialist: string; step: string }> = [];
      runner.on((event) => {
        if (event.type === 'step:owner-assigned') {
          ownerAssignments.push({
            owner: event.ownerName,
            specialist: event.specialistName,
            step: event.stepName,
          });
        }
      });

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke' },
        agents: [
          { name: 'team-lead', cli: 'claude', role: 'Lead coordinator' },
          { name: 'worker-1', cli: 'claude', role: 'implementer' },
          { name: 'worker-2', cli: 'claude', role: 'implementer' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'work-1', agent: 'worker-1', task: 'Do task A' },
              { name: 'work-2', agent: 'worker-2', task: 'Do task B' },
              {
                name: 'lead-coord',
                agent: 'team-lead',
                task: 'Coordinate workers',
                dependsOn: ['work-1', 'work-2'],
              },
            ],
          },
        ],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments.length).toBeGreaterThanOrEqual(3);

      const worker1Owner = ownerAssignments.find((a) => a.step === 'work-1');
      const worker2Owner = ownerAssignments.find((a) => a.step === 'work-2');
      expect(worker1Owner?.owner).toBe('team-lead');
      expect(worker2Owner?.owner).toBe('team-lead');

      const leadOwner = ownerAssignments.find((a) => a.step === 'lead-coord');
      expect(leadOwner?.owner).toBe('team-lead');
    }, 30000);
  });

  // ── Scenario 8: YAML workflow parsing ──────────────────────────────────

  describe('Scenario 8: E2E workflow YAML validation', () => {
    it('should parse the e2e-owner-review.yaml without errors', () => {
      const yamlPath = resolve(__dirname, '../../../../tests/workflows/e2e-owner-review.yaml');
      const yamlContent = readFileSync(yamlPath, 'utf-8');

      // parseYamlString is an instance method
      const config = runner.parseYamlString(yamlContent);
      expect(config.name).toBe('e2e-owner-review');
      expect(config.agents).toHaveLength(5);
      expect(config.workflows).toHaveLength(1);

      const agentNames = config.agents!.map((a: any) => a.name);
      expect(agentNames).toContain('team-lead');
      expect(agentNames).toContain('github-integration');
      expect(agentNames).toContain('impl-worker');
      expect(agentNames).toContain('quality-reviewer');
      expect(agentNames).toContain('coordinator-bot');

      const steps = config.workflows![0].steps;
      const stepNames = steps.map((s: any) => s.name);
      expect(stepNames).toContain('hub-owner-test');
      expect(stepNames).toContain('github-no-hub-match');
      expect(stepNames).toContain('review-approval-gate');
      expect(stepNames).toContain('deliberate-bad-output');
      expect(stepNames).toContain('tight-timeout-step');
      expect(stepNames).toContain('team-lead-coord');
      expect(stepNames).toContain('merge-results');
    });

    it('should detect hub-role agents correctly from YAML', () => {
      const yamlPath = resolve(__dirname, '../../../../tests/workflows/e2e-owner-review.yaml');
      const yamlContent = readFileSync(yamlPath, 'utf-8');
      const config = runner.parseYamlString(yamlContent);

      const teamLead = config.agents!.find((a: any) => a.name === 'team-lead');
      expect(teamLead?.role).toMatch(/\blead\b/i);

      const githubAgent = config.agents!.find((a: any) => a.name === 'github-integration');
      expect(githubAgent?.role).not.toMatch(/\bhub\b/i);
      expect(githubAgent?.name).not.toMatch(/\bhub\b/i);

      const coordBot = config.agents!.find((a: any) => a.name === 'coordinator-bot');
      expect(coordBot?.role).toMatch(/\bcoordinator\b/i);
    });
  });

  // ── Scenario 9: Owner completion marker validation ─────────────────────

  describe('Scenario 9: Owner completion marker', () => {
    it('should fail when owner does not provide a marker, decision, or evidence', async () => {
      mockSpawnOutputs = ['The work is done but I forgot the sentinel.\n'];

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner completion decision missing');
    }, 15000);

    it('should succeed when owner produces correct STEP_COMPLETE:step-name', async () => {
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);
  });
});
