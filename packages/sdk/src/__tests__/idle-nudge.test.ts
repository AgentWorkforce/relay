/**
 * Idle nudge detection and escalation tests.
 *
 * Covers both modes:
 * - No idleNudge config: idle is treated as completion.
 * - idleNudge config enabled: waitForExit timeout drives nudges/escalation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowDb } from '../workflows/runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../workflows/types.js';

// ── Mock fetch to prevent real HTTP calls (Relaycast provisioning) ───────────

const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: { api_key: 'rk_live_test', workspace_id: 'ws-test' } }),
  text: () => Promise.resolve(''),
});
vi.stubGlobal('fetch', mockFetch);

// ── Mock RelayCast SDK ────────────────────────────────────────────────────────

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

// ── Mock AgentRelay ───────────────────────────────────────────────────────────

let waitForExitFn: (ms?: number) => Promise<'exited' | 'timeout' | 'released'>;
let waitForIdleFn: (ms?: number) => Promise<'idle' | 'timeout' | 'exited'>;

const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockRelease = vi.fn().mockResolvedValue(undefined);

const mockAgent = {
  name: 'test-agent-abc',
  exitCode: 0,
  exitSignal: undefined,
  get waitForExit() {
    return waitForExitFn;
  },
  get waitForIdle() {
    return waitForIdleFn;
  },
  release: mockRelease,
  sendMessage: mockSendMessage,
};

const mockHumanSendMessage = vi.fn().mockResolvedValue(undefined);
const mockHuman = {
  name: 'workflow-runner',
  sendMessage: mockHumanSendMessage,
};

vi.mock('../relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => ({
    spawnPty: vi.fn().mockResolvedValue(mockAgent),
    human: vi.fn().mockReturnValue(mockHuman),
    shutdown: vi.fn().mockResolvedValue(undefined),
    onBrokerStderr: vi.fn().mockReturnValue(() => {}),
    onWorkerOutput: null,
    listAgentsRaw: vi.fn().mockResolvedValue([]),
  })),
}));

const { WorkflowRunner } = await import('../workflows/runner.js');

// ── Test fixtures ─────────────────────────────────────────────────────────────

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
    name: 'test-workflow',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'agent-a', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do step 1' }],
      },
    ],
    trajectories: false,
    ...overrides,
  };
}

function never<T>(): Promise<T> {
  return new Promise(() => {});
}

describe('Idle Nudge Detection', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });

    waitForExitFn = vi.fn().mockResolvedValue('exited');
    waitForIdleFn = vi.fn().mockResolvedValue('timeout');
  });

  describe('idleNudge enabled', () => {
    it('sends direct nudge then completes when exit follows', async () => {
      let exitCallCount = 0;
      waitForExitFn = vi.fn().mockImplementation(() => {
        exitCallCount++;
        return Promise.resolve(exitCallCount === 1 ? 'timeout' : 'exited');
      });

      const run = await runner.execute(
        makeConfig({
          swarm: {
            pattern: 'mesh',
            idleNudge: { nudgeAfterMs: 100, escalateAfterMs: 100, maxNudges: 1 },
          },
        }),
        'default'
      );

      expect(run.status).toBe('completed');
      expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
      expect(mockHumanSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test-agent-abc',
          text: expect.stringContaining('/exit'),
        })
      );
      expect(mockRelease).not.toHaveBeenCalled();
      expect(waitForIdleFn).not.toHaveBeenCalled();
    });

    it('uses hub fallback behavior without failing when hub is not active', async () => {
      let exitCallCount = 0;
      waitForExitFn = vi.fn().mockImplementation(() => {
        exitCallCount++;
        return Promise.resolve(exitCallCount === 1 ? 'timeout' : 'exited');
      });

      const config = makeConfig({
        swarm: {
          pattern: 'hub-spoke',
          idleNudge: { nudgeAfterMs: 100, escalateAfterMs: 100, maxNudges: 1 },
        },
        agents: [
          { name: 'lead', cli: 'claude', role: 'Lead coordinator' },
          { name: 'worker', cli: 'claude' },
        ],
      });
      const step = { name: 'step-1', agent: 'worker', task: 'Do work' };
      const agentDef = { name: 'worker', cli: 'claude' };

      (runner as any).currentConfig = config;
      (runner as any).relay = { human: vi.fn().mockReturnValue(mockHuman) };
      const result = await (runner as any).waitForExitWithIdleNudging(mockAgent, agentDef, step, 500);

      expect(result).toBe('exited');
      expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
    });

    it('force-releases after maxNudges is exceeded', async () => {
      waitForExitFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(
        makeConfig({
          swarm: {
            pattern: 'dag',
            idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
          },
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(run.error).toContain('force-released');
      expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
      expect(mockRelease).toHaveBeenCalledTimes(1);
      expect(waitForIdleFn).not.toHaveBeenCalled();
    });

    it('force-releases after multiple nudges', async () => {
      waitForExitFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(
        makeConfig({
          swarm: {
            pattern: 'dag',
            idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 3 },
          },
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(run.error).toContain('force-released');
      expect(mockHumanSendMessage).toHaveBeenCalledTimes(3);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('emits step:nudged event', async () => {
      let exitCallCount = 0;
      waitForExitFn = vi.fn().mockImplementation(() => {
        exitCallCount++;
        return Promise.resolve(exitCallCount === 1 ? 'timeout' : 'exited');
      });

      const events: Array<{ type: string }> = [];
      runner.on((event) => events.push(event));

      await runner.execute(
        makeConfig({
          swarm: {
            pattern: 'dag',
            idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
          },
        }),
        'default'
      );

      expect(events.filter((e) => e.type === 'step:nudged')).toHaveLength(1);
    });

    it('emits step:force-released event on escalation', async () => {
      waitForExitFn = vi.fn().mockResolvedValue('timeout');

      const events: Array<{ type: string }> = [];
      runner.on((event) => events.push(event));

      await runner.execute(
        makeConfig({
          swarm: {
            pattern: 'dag',
            idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
          },
        }),
        'default'
      );

      expect(events.filter((e) => e.type === 'step:force-released')).toHaveLength(1);
    });

    it('uses defaults when idleNudge is empty object', async () => {
      waitForExitFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(
        makeConfig({
          swarm: {
            pattern: 'dag',
            idleNudge: {},
          },
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(run.error).toContain('force-released');
      // default maxNudges is 1
      expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('respects overall timeout during nudge loop', async () => {
      // Each waitForExit call takes 100ms (real timer), but the overall timeout
      // is only 80ms. After the first call (~100ms elapsed), the loop detects
      // that remaining time is exhausted and returns 'timeout'.
      waitForExitFn = vi
        .fn()
        .mockImplementation(
          () => new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100))
        );

      const run = await runner.execute(
        makeConfig({
          swarm: {
            pattern: 'dag',
            idleNudge: { nudgeAfterMs: 10, escalateAfterMs: 10, maxNudges: 10 },
          },
          agents: [{ name: 'agent-a', cli: 'claude', constraints: { timeoutMs: 80 } }],
        }),
        'default'
      );

      expect(run.status).toBe('failed');
      expect(run.error).toContain('timed out');
    });

    it('keeps a supervising lead alive after idle nudges are exhausted', async () => {
      let exitCallCount = 0;
      waitForExitFn = vi.fn().mockImplementation(() => {
        exitCallCount++;
        return Promise.resolve(exitCallCount < 3 ? 'timeout' : 'exited');
      });

      const config = makeConfig({
        swarm: {
          pattern: 'hub-spoke',
          idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
          channel: 'lead-supervision',
        },
      });
      const agentDef = { name: 'team-lead', cli: 'claude', role: 'Lead coordinator' };
      const step = {
        name: 'step-1',
        agent: 'team-lead',
        task: 'Monitor #lead-supervision for WORKER_DONE, wait for the handoff, then exit.',
      };

      (runner as any).currentConfig = config;
      expect((runner as any).shouldPreserveIdleSupervisor(agentDef, step)).toBe(true);

      const result = await (runner as any).waitForExitWithIdleNudging(
        mockAgent,
        agentDef,
        step,
        500,
        undefined,
        true
      );

      expect(result).toBe('exited');
      expect(waitForExitFn).toHaveBeenCalledTimes(3);
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });

  describe('Idle = done (no idleNudge config)', () => {
    it('idle fires first: releases agent and completes step', async () => {
      waitForIdleFn = vi.fn().mockResolvedValue('idle');
      waitForExitFn = vi.fn().mockImplementation(() => never());

      const run = await runner.execute(makeConfig(), 'default');
      const steps = await db.getStepsByRunId(run.id);

      expect(run.status).toBe('completed');
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('completed');
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('exit fires first: completes without idle-based release', async () => {
      waitForExitFn = vi.fn().mockResolvedValue('exited');
      waitForIdleFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(makeConfig(), 'default');
      const steps = await db.getStepsByRunId(run.id);

      expect(run.status).toBe('completed');
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('completed');
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it('does not treat supervisory lead idleness as completion', async () => {
      waitForExitFn = vi.fn().mockResolvedValue('exited');
      waitForIdleFn = vi.fn().mockResolvedValue('idle');

      const config = makeConfig({
        swarm: { pattern: 'hub-spoke', channel: 'lead-supervision' },
      });
      const agentDef = { name: 'team-lead', cli: 'claude', role: 'Lead coordinator' };
      const step = {
        name: 'step-1',
        agent: 'team-lead',
        task: 'Wait on #lead-supervision for WORKER_DONE before handing off.',
      };

      (runner as any).currentConfig = config;
      expect((runner as any).shouldPreserveIdleSupervisor(agentDef, step)).toBe(true);

      const result = await (runner as any).waitForExitWithIdleNudging(
        mockAgent,
        agentDef,
        step,
        500,
        undefined,
        true
      );

      expect(result).toBe('exited');
      expect(waitForExitFn).toHaveBeenCalledTimes(1);
      expect(waitForIdleFn).not.toHaveBeenCalled();
      expect(mockRelease).not.toHaveBeenCalled();
    });

    it('both timeout: fails step with timeout error', async () => {
      waitForExitFn = vi.fn().mockResolvedValue('timeout');
      waitForIdleFn = vi.fn().mockResolvedValue('timeout');

      const run = await runner.execute(makeConfig(), 'default');
      const steps = await db.getStepsByRunId(run.id);

      expect(run.status).toBe('failed');
      expect(run.error).toContain('timed out');
      expect(steps).toHaveLength(1);
      expect(steps[0]?.status).toBe('failed');
      expect(steps[0]?.error).toContain('timed out');
    });
  });
});
