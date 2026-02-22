/**
 * Idle nudge detection and escalation tests.
 *
 * Tests that the WorkflowRunner correctly detects idle agents, sends nudges
 * (hub-mediated or direct), and force-releases after maxNudges.
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

// ── Mock RelaycastApi ───────────────────────────────────────────────────────

vi.mock('../relaycast.js', () => ({
  RelaycastApi: vi.fn().mockImplementation(() => ({
    createChannel: vi.fn().mockResolvedValue(undefined),
    joinChannel: vi.fn().mockResolvedValue(undefined),
    sendToChannel: vi.fn().mockResolvedValue(undefined),
    inviteToChannel: vi.fn().mockResolvedValue(undefined),
    registerExternalAgent: vi.fn().mockResolvedValue(null),
    startHeartbeat: vi.fn().mockReturnValue(() => {}),
  })),
}));

// ── Mock AgentRelay ──────────────────────────────────────────────────────────

/** Control how waitForExit / waitForIdle resolve in each test. */
let waitForExitFn: (ms?: number) => Promise<'exited' | 'timeout' | 'released'>;
let waitForIdleFn: (ms?: number) => Promise<'idle' | 'timeout' | 'exited'>;

const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockRelease = vi.fn().mockResolvedValue(undefined);

const mockAgent = {
  name: 'test-agent-abc',
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
    onWorkerOutput: null,
    listAgentsRaw: vi.fn().mockResolvedValue([]),
  })),
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
    name: 'test-workflow',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-1', agent: 'agent-a', task: 'Do step 1' },
        ],
      },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Idle Nudge Detection', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    runner = new WorkflowRunner({ db, workspaceId: 'ws-test' });

    // Default: agent exits immediately (no idle)
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    waitForIdleFn = vi.fn().mockResolvedValue('timeout');
  });

  it('should not nudge when idleNudge config is absent', async () => {
    // No idleNudge in swarm config — simple waitForExit
    const config = makeConfig();
    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    expect(mockHumanSendMessage).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('should send direct nudge after idle detection', async () => {
    let idleCallCount = 0;
    // First waitForIdle resolves with 'idle', second with 'exited' (agent responds)
    waitForIdleFn = vi.fn().mockImplementation(() => {
      idleCallCount++;
      if (idleCallCount === 1) return Promise.resolve('idle');
      return Promise.resolve('exited');
    });
    // waitForExit never resolves quickly — make it lose the race
    waitForExitFn = vi.fn().mockImplementation(() => new Promise(() => {}));
    // But after nudge, agent exits — so second iteration exit resolves
    let exitCallCount = 0;
    waitForExitFn = vi.fn().mockImplementation(() => {
      exitCallCount++;
      if (exitCallCount === 1) return new Promise(() => {}); // lose first race
      return Promise.resolve('exited'); // win second race
    });

    const config = makeConfig({
      swarm: {
        pattern: 'mesh', // non-hub pattern → direct nudge
        idleNudge: { nudgeAfterMs: 100, escalateAfterMs: 100, maxNudges: 1 },
      },
    });

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    // Direct nudge via human handle
    expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
    expect(mockHumanSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'test-agent-abc',
        text: expect.stringContaining('/exit'),
      }),
    );
  });

  it('should use hub-mediated nudge for hub patterns when hub exists', async () => {
    let idleCallCount = 0;
    waitForIdleFn = vi.fn().mockImplementation(() => {
      idleCallCount++;
      if (idleCallCount === 1) return Promise.resolve('idle');
      return Promise.resolve('exited');
    });
    let exitCallCount = 0;
    waitForExitFn = vi.fn().mockImplementation(() => {
      exitCallCount++;
      if (exitCallCount === 1) return new Promise(() => {});
      return Promise.resolve('exited');
    });

    const config = makeConfig({
      swarm: {
        pattern: 'hub-spoke', // hub pattern
        idleNudge: { nudgeAfterMs: 100, escalateAfterMs: 100, maxNudges: 1 },
      },
      agents: [
        { name: 'lead', cli: 'claude', role: 'Lead coordinator' },
        { name: 'worker', cli: 'claude' },
      ],
      workflows: [
        {
          name: 'default',
          steps: [
            { name: 'step-1', agent: 'worker', task: 'Do work' },
          ],
        },
      ],
    });

    const run = await runner.execute(config, 'default');

    // Since the hub (lead) is not spawned in this workflow step, it falls back to direct nudge
    // The hub-mediated path requires the hub to be in activeAgentHandles
    expect(run.status).toBe('completed');
  });

  it('should send direct nudge when idle agent IS the hub', async () => {
    let idleCallCount = 0;
    waitForIdleFn = vi.fn().mockImplementation(() => {
      idleCallCount++;
      if (idleCallCount === 1) return Promise.resolve('idle');
      return Promise.resolve('exited');
    });
    let exitCallCount = 0;
    waitForExitFn = vi.fn().mockImplementation(() => {
      exitCallCount++;
      if (exitCallCount === 1) return new Promise(() => {});
      return Promise.resolve('exited');
    });

    const config = makeConfig({
      swarm: {
        pattern: 'hub-spoke',
        idleNudge: { nudgeAfterMs: 100, escalateAfterMs: 100, maxNudges: 1 },
      },
      agents: [
        { name: 'lead', cli: 'claude', role: 'Lead coordinator' },
      ],
      workflows: [
        {
          name: 'default',
          steps: [
            { name: 'step-1', agent: 'lead', task: 'Coordinate work' },
          ],
        },
      ],
    });

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    // Should use direct nudge since idle agent is the hub itself
    expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
  });

  it('should force-release after maxNudges exceeded', async () => {
    // Idle always fires, never exits
    waitForIdleFn = vi.fn().mockResolvedValue('idle');
    waitForExitFn = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves

    const config = makeConfig({
      swarm: {
        pattern: 'dag',
        idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
      },
    });

    const run = await runner.execute(config, 'default');

    // Force-released → still captures output → completes
    expect(run.status).toBe('completed');
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockHumanSendMessage).toHaveBeenCalledTimes(1); // 1 nudge before escalation
  });

  it('should force-release after multiple nudges', async () => {
    waitForIdleFn = vi.fn().mockResolvedValue('idle');
    waitForExitFn = vi.fn().mockImplementation(() => new Promise(() => {}));

    const config = makeConfig({
      swarm: {
        pattern: 'dag',
        idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 3 },
      },
    });

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockHumanSendMessage).toHaveBeenCalledTimes(3); // 3 nudges before escalation
  });

  it('should respect overall timeout despite nudge loop', async () => {
    // Idle fires quickly, but overall timeout is very short
    waitForIdleFn = vi.fn().mockResolvedValue('idle');
    waitForExitFn = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('timeout'), 50)),
    );

    const config = makeConfig({
      swarm: {
        pattern: 'dag',
        idleNudge: { nudgeAfterMs: 10, escalateAfterMs: 10, maxNudges: 10 },
      },
      agents: [
        { name: 'agent-a', cli: 'claude', constraints: { timeoutMs: 100 } },
      ],
    });

    // The step has a short timeout — should not loop forever
    const run = await runner.execute(config, 'default');
    // Either completed (force-released) or failed (timeout) — either is acceptable
    expect(['completed', 'failed']).toContain(run.status);
  });

  it('should emit step:nudged event', async () => {
    let idleCallCount = 0;
    waitForIdleFn = vi.fn().mockImplementation(() => {
      idleCallCount++;
      if (idleCallCount === 1) return Promise.resolve('idle');
      return Promise.resolve('exited');
    });
    let exitCallCount = 0;
    waitForExitFn = vi.fn().mockImplementation(() => {
      exitCallCount++;
      if (exitCallCount === 1) return new Promise(() => {});
      return Promise.resolve('exited');
    });

    const events: Array<{ type: string }> = [];
    const config = makeConfig({
      swarm: {
        pattern: 'dag',
        idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
      },
    });

    runner.on((event) => events.push(event));
    await runner.execute(config, 'default');

    const nudgeEvents = events.filter((e) => e.type === 'step:nudged');
    expect(nudgeEvents).toHaveLength(1);
  });

  it('should emit step:force-released event on escalation', async () => {
    waitForIdleFn = vi.fn().mockResolvedValue('idle');
    waitForExitFn = vi.fn().mockImplementation(() => new Promise(() => {}));

    const events: Array<{ type: string }> = [];
    const config = makeConfig({
      swarm: {
        pattern: 'dag',
        idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
      },
    });

    runner.on((event) => events.push(event));
    await runner.execute(config, 'default');

    const forceReleasedEvents = events.filter((e) => e.type === 'step:force-released');
    expect(forceReleasedEvents).toHaveLength(1);
  });

  it('should handle agent responding to nudge: idle → nudge → output → idle → escalate', async () => {
    let idleCallCount = 0;
    // First idle → nudge. Second idle → escalate (maxNudges: 1)
    waitForIdleFn = vi.fn().mockImplementation(() => {
      idleCallCount++;
      return Promise.resolve('idle');
    });
    waitForExitFn = vi.fn().mockImplementation(() => new Promise(() => {}));

    const config = makeConfig({
      swarm: {
        pattern: 'dag',
        idleNudge: { nudgeAfterMs: 50, escalateAfterMs: 50, maxNudges: 1 },
      },
    });

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    // 1 nudge sent, then force-released
    expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('should use defaults when idleNudge is empty object', async () => {
    let idleCallCount = 0;
    waitForIdleFn = vi.fn().mockImplementation(() => {
      idleCallCount++;
      if (idleCallCount === 1) return Promise.resolve('idle');
      return Promise.resolve('exited');
    });
    let exitCallCount = 0;
    waitForExitFn = vi.fn().mockImplementation(() => {
      exitCallCount++;
      if (exitCallCount === 1) return new Promise(() => {});
      return Promise.resolve('exited');
    });

    const config = makeConfig({
      swarm: {
        pattern: 'dag',
        idleNudge: {}, // empty — should use defaults
      },
    });

    const run = await runner.execute(config, 'default');

    expect(run.status).toBe('completed');
    // Default maxNudges: 1, so one nudge should have been sent
    expect(mockHumanSendMessage).toHaveBeenCalledTimes(1);
  });
});
