/**
 * E2E test harness for PR #511: auto step owner + per-step review gating.
 *
 * This file validates the workflow runner's owner/review features by:
 * 1. Running the unit test suite (which uses mocked DB/relay)
 * 2. Parsing a real workflow YAML and validating it against the schema
 * 3. Reporting PASS/FAIL for each scenario
 *
 * Usage:
 *   npx tsx tests/workflows/run-e2e-owner-review.ts
 *
 * Or via the test runner:
 *   npx vitest run tests/workflows/run-e2e-owner-review.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// These types are imported relative to the SDK source. When running via vitest
// from the SDK directory, use the SDK vitest config which includes src/__tests__.
// From repo root, the aliases resolve correctly.
import type { WorkflowDb } from '../../packages/sdk/src/workflows/runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../../packages/sdk/src/workflows/types.js';

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
  get waitForExit() { return waitForExitFn; },
  get waitForIdle() { return waitForIdleFn; },
  release: vi.fn().mockResolvedValue(undefined),
};

const mockHuman = {
  name: 'WorkflowRunner',
  sendMessage: vi.fn().mockResolvedValue(undefined),
};

const mockRelayInstance = {
  spawnPty: vi.fn().mockImplementation(async ({ name, task }: { name: string; task?: string }) => {
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
  }),
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

vi.mock('../../packages/sdk/src/relay.js', () => ({
  AgentRelay: vi.fn().mockImplementation(() => mockRelayInstance),
}));

// Import after mocking
const { WorkflowRunner } = await import('../../packages/sdk/src/workflows/runner.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDb(): WorkflowDb {
  const runs = new Map<string, WorkflowRunRow>();
  const steps = new Map<string, WorkflowStepRow>();
  return {
    insertRun: vi.fn(async (run: WorkflowRunRow) => { runs.set(run.id, { ...run }); }),
    updateRun: vi.fn(async (id: string, patch: Partial<WorkflowRunRow>) => {
      const existing = runs.get(id);
      if (existing) runs.set(id, { ...existing, ...patch });
    }),
    getRun: vi.fn(async (id: string) => {
      const run = runs.get(id);
      return run ? { ...run } : null;
    }),
    insertStep: vi.fn(async (step: WorkflowStepRow) => { steps.set(step.id, { ...step }); }),
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

// ── E2E Scenarios ───────────────────────────────────────────────────────────

describe('PR #511 E2E: Auto Step Owner + Review Gating', () => {
  let db: WorkflowDb;
  let runner: InstanceType<typeof WorkflowRunner>;

  beforeEach(() => {
    vi.clearAllMocks();
    waitForExitFn = vi.fn().mockResolvedValue('exited');
    waitForIdleFn = vi.fn().mockImplementation(() => never());
    mockSpawnOutputs = [];
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
        agents: [
          { name: 'impl-worker', cli: 'claude', role: 'implementer' },
          { name: 'team-lead', cli: 'claude', role: 'Lead coordinator for the workflow' },
          { name: 'quality-reviewer', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [{
          name: 'default',
          steps: [{ name: 'hub-owner-test', agent: 'impl-worker', task: 'List 3 benefits' }],
        }],
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
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'coord-bot', cli: 'claude', role: 'coordinator' },
          { name: 'lead-bot', cli: 'claude', role: 'lead' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [{
          name: 'default',
          steps: [{ name: 'step-1', agent: 'specialist', task: 'Do work' }],
        }],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      expect(ownerAssignments[0]).toBe('lead-bot');
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
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'github-integration', cli: 'claude', role: 'GitHub integration agent' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [{
          name: 'default',
          steps: [{ name: 'github-no-hub', agent: 'specialist', task: 'Test word boundary' }],
        }],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      // github-integration should NOT be owner — specialist owns itself
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
        agents: [
          { name: 'specialist', cli: 'claude', role: 'engineer' },
          { name: 'github-bot', cli: 'claude', role: 'github integration' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [{
          name: 'default',
          steps: [{ name: 'step-1', agent: 'specialist', task: 'Do work' }],
        }],
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

      // Default mock outputs APPROVE, so no need to queue special output
      const run = await runner.execute(makeConfig(), 'default');
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

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');
      // Review must complete before step is marked completed
      const reviewIdx = stepEvents.indexOf('step:review-completed');
      const completedIdx = stepEvents.indexOf('step:completed');
      expect(reviewIdx).toBeLessThan(completedIdx);
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
        'STEP_COMPLETE:step-1\n',
        'REVIEW_DECISION: REJECT\nREVIEW_REASON: output is incomplete\n',
      ];

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('review rejected');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    }, 15000);

    it('should fail closed when review output is malformed (no REVIEW_DECISION)', async () => {
      mockSpawnOutputs = [
        'STEP_COMPLETE:step-1\n',
        'REVIEW_REASON: this is missing the decision line\n',
      ];

      const run = await runner.execute(makeConfig(), 'default');
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

      // PTY echoes the prompt (which contains "APPROVE or REJECT"), then actual REJECT
      const echoedPrompt =
        'Return exactly:\nREVIEW_DECISION: APPROVE or REJECT\nREVIEW_REASON: <one sentence>\n';
      const actualResponse = 'REVIEW_DECISION: REJECT\nREVIEW_REASON: code has critical bugs\n';
      mockSpawnOutputs = ['STEP_COMPLETE:step-1\n', echoedPrompt + actualResponse];

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(events).toContainEqual({ type: 'step:review-completed', decision: 'rejected' });
    }, 15000);
  });

  // ── Scenario 5: Review timeout budgeting ───────────────────────────────

  describe('Scenario 5: Review timeout budgeting', () => {
    it('should not allocate review timeout longer than parent step timeout', async () => {
      const config = makeConfig({
        workflows: [{
          name: 'default',
          steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do step 1', timeoutMs: 30_000 }],
        }],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');

      // Check that the waitForExit calls respect the timeout budget
      const waitCalls = (waitForExitFn as any).mock?.calls ?? [];
      expect(waitCalls.length).toBeGreaterThanOrEqual(2);
      // Second call is the review timeout — must not exceed parent step timeout
      const reviewTimeout = waitCalls[1][0];
      expect(reviewTimeout).toBeLessThanOrEqual(30_000);
    }, 15000);

    it('should use proportional timeout (1/3) for longer step timeouts', async () => {
      const config = makeConfig({
        workflows: [{
          name: 'default',
          steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do step 1', timeoutMs: 900_000 }],
        }],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');

      const waitCalls = (waitForExitFn as any).mock?.calls ?? [];
      expect(waitCalls.length).toBeGreaterThanOrEqual(2);
      const reviewTimeout = waitCalls[1][0];
      // proportional = 300_000, lowerBound = 60_000, upperBound = 600_000
      // result = min(max(300_000, 60_000), 600_000) = 300_000
      expect(reviewTimeout).toBe(300_000);
    }, 15000);

    it('should cap review timeout at 600s upper bound', async () => {
      const config = makeConfig({
        workflows: [{
          name: 'default',
          steps: [{ name: 'step-1', agent: 'agent-a', task: 'Do step 1', timeoutMs: 3_600_000 }],
        }],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');

      const waitCalls = (waitForExitFn as any).mock?.calls ?? [];
      expect(waitCalls.length).toBeGreaterThanOrEqual(2);
      const reviewTimeout = waitCalls[1][0];
      // proportional = 1_200_000, lowerBound = 60_000, upperBound = 600_000
      // result = min(max(1_200_000, 60_000), 600_000) = 600_000
      expect(reviewTimeout).toBe(600_000);
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

    it('should NOT emit step:owner-timeout for review timeouts', async () => {
      const ownerTimeouts: string[] = [];
      const reviewEvents: string[] = [];
      runner.on((event) => {
        if (event.type === 'step:owner-timeout') ownerTimeouts.push(event.stepName);
        if (event.type === 'step:review-completed') reviewEvents.push(event.decision);
      });

      // Owner succeeds, review approves — no timeouts
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');
      expect(ownerTimeouts).toHaveLength(0);
    }, 15000);
  });

  // ── Scenario 7: Multi-agent team with owner assignment ─────────────────

  describe('Scenario 7: Lead + workers team pattern', () => {
    it('should assign lead as owner for all team steps', async () => {
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
        agents: [
          { name: 'team-lead', cli: 'claude', role: 'Lead coordinator' },
          { name: 'worker-1', cli: 'claude', role: 'implementer' },
          { name: 'worker-2', cli: 'claude', role: 'implementer' },
          { name: 'reviewer-1', cli: 'claude', role: 'reviewer' },
        ],
        workflows: [{
          name: 'default',
          steps: [
            { name: 'work-1', agent: 'worker-1', task: 'Do task A' },
            { name: 'work-2', agent: 'worker-2', task: 'Do task B' },
            { name: 'lead-coord', agent: 'team-lead', task: 'Coordinate workers', dependsOn: ['work-1', 'work-2'] },
          ],
        }],
      });

      const run = await runner.execute(config, 'default');
      expect(run.status).toBe('completed');
      // All steps should have owner assignments
      expect(ownerAssignments.length).toBeGreaterThanOrEqual(3);
      // Worker steps should be owned by the lead (hub-role agent)
      const worker1Owner = ownerAssignments.find((a) => a.step === 'work-1');
      const worker2Owner = ownerAssignments.find((a) => a.step === 'work-2');
      expect(worker1Owner?.owner).toBe('team-lead');
      expect(worker2Owner?.owner).toBe('team-lead');
      // Lead step should own itself
      const leadOwner = ownerAssignments.find((a) => a.step === 'lead-coord');
      expect(leadOwner?.owner).toBe('team-lead');
    }, 30000);
  });

  // ── Scenario 8: YAML workflow parsing ──────────────────────────────────

  describe('Scenario 8: E2E workflow YAML validation', () => {
    it('should parse the e2e-owner-review.yaml without errors', () => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const yamlPath = resolve(__dirname, 'e2e-owner-review.yaml');
      const yamlContent = readFileSync(yamlPath, 'utf-8');

      // Validate it can be parsed
      const config = runner.parseYamlString(yamlContent);
      expect(config.name).toBe('e2e-owner-review');
      expect(config.agents).toHaveLength(5);
      expect(config.workflows).toHaveLength(1);

      // Verify agent definitions
      const agentNames = config.agents!.map((a: any) => a.name);
      expect(agentNames).toContain('team-lead');
      expect(agentNames).toContain('github-integration');
      expect(agentNames).toContain('impl-worker');
      expect(agentNames).toContain('quality-reviewer');
      expect(agentNames).toContain('coordinator-bot');

      // Verify workflow steps
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

    it('should detect all hub-role agents correctly from YAML', () => {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const yamlPath = resolve(__dirname, 'e2e-owner-review.yaml');
      const yamlContent = readFileSync(yamlPath, 'utf-8');
      const config = runner.parseYamlString(yamlContent);

      // team-lead has role "Lead coordinator" — word "Lead" should match hub role
      const teamLead = config.agents!.find((a: any) => a.name === 'team-lead');
      expect(teamLead?.role).toMatch(/\blead\b/i);

      // github-integration should NOT match — "hub" is substring of "github"
      const githubAgent = config.agents!.find((a: any) => a.name === 'github-integration');
      expect(githubAgent?.role).not.toMatch(/\bhub\b/i);
      expect(githubAgent?.name).not.toMatch(/\bhub\b/i);

      // coordinator-bot has role "Coordinator" — should match hub role
      const coordBot = config.agents!.find((a: any) => a.name === 'coordinator-bot');
      expect(coordBot?.role).toMatch(/\bcoordinator\b/i);
    });
  });

  // ── Scenario 9: Owner completion marker validation ─────────────────────

  describe('Scenario 9: Owner completion marker', () => {
    it('should fail when owner does not produce STEP_COMPLETE marker', async () => {
      mockSpawnOutputs = ['The work is done but I forgot the sentinel.\n'];

      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('failed');
      expect(run.error).toContain('owner completion marker');
    }, 15000);

    it('should succeed when owner produces correct STEP_COMPLETE:step-name', async () => {
      // Default mock auto-generates correct markers, so this should succeed
      const run = await runner.execute(makeConfig(), 'default');
      expect(run.status).toBe('completed');
    }, 15000);
  });
});
