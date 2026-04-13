import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliSessionReport } from '../cli-session-collector.js';
import type { RelayYamlConfig } from '../types.js';

const mockedReports = vi.hoisted(() => ({
  queue: [] as Array<CliSessionReport | null>,
}));

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn(),
  RelayError: class RelayError extends Error {},
}));

vi.mock('../../relay.js', () => ({
  AgentRelay: vi.fn(),
}));

vi.mock('../cli-session-collector.js', () => ({
  collectCliSession: vi.fn(async () => mockedReports.queue.shift() ?? null),
}));

const { WorkflowRunner } = await import('../runner.js');
const { InMemoryWorkflowDb } = await import('../memory-db.js');

const tempDirs: string[] = [];

function createWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-budget-'));
  tempDirs.push(dir);
  return dir;
}

function makeReport(
  input: number,
  output: number,
  finalStatus: 'completed' | 'failed' = 'completed'
): CliSessionReport {
  return {
    cli: 'codex' as const,
    sessionId: `session-${input}-${output}`,
    model: 'gpt-5',
    provider: 'openai',
    durationMs: 1_000,
    cost: null,
    tokens: { input, output, cacheRead: 0 },
    turns: 1,
    toolCalls: [],
    errors: [],
    finalStatus,
    summary: `used ${input + output} tokens`,
  };
}

function makeConfig(overrides?: {
  tokenBudget?: number;
  maxTokens?: number;
  retries?: number;
}): RelayYamlConfig {
  return {
    version: '1',
    name: 'budget-enforcement',
    swarm: {
      pattern: 'dag',
      tokenBudget: overrides?.tokenBudget,
    },
    agents: [
      {
        name: 'worker',
        cli: 'codex',
        interactive: false,
        constraints: overrides?.maxTokens ? { maxTokens: overrides.maxTokens } : undefined,
      },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'step-1',
            agent: 'worker',
            task: 'Do the first task',
            retries: overrides?.retries,
          },
          {
            name: 'step-2',
            agent: 'worker',
            task: 'Do the second task',
            dependsOn: ['step-1'],
          },
        ],
      },
    ],
    trajectories: false,
  };
}

afterEach(() => {
  mockedReports.queue = [];
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('WorkflowRunner token budget enforcement', () => {
  it('blocks later steps once the workflow budget is exhausted', async () => {
    mockedReports.queue = [makeReport(60, 50)];

    const db = new InMemoryWorkflowDb();
    const executor = {
      executeAgentStep: vi.fn(async (step) => `completed ${step.name}`),
    };
    const runner = new WorkflowRunner({
      cwd: createWorkspace(),
      db,
      executor,
    });

    const run = await runner.execute(makeConfig({ tokenBudget: 100, maxTokens: 80 }), 'default');
    const steps = await db.getStepsByRunId(run.id);

    expect(run.status).toBe('failed');
    expect(executor.executeAgentStep).toHaveBeenCalledTimes(1);
    expect(steps.find((step) => step.stepName === 'step-1')?.status).toBe('completed');
    expect(steps.find((step) => step.stepName === 'step-2')?.status).toBe('failed');
    expect(steps.find((step) => step.stepName === 'step-2')?.completionReason).toBe(
      'failed_budget_exceeded'
    );
    expect(steps.find((step) => step.stepName === 'step-2')?.error).toContain(
      'Workflow exceeded workflow budget'
    );
  });

  it('counts failed attempts against the same workflow budget before retrying later steps', async () => {
    mockedReports.queue = [makeReport(40, 20, 'failed'), makeReport(30, 20)];

    const db = new InMemoryWorkflowDb();
    const executor = {
      executeAgentStep: vi
        .fn()
        .mockRejectedValueOnce(new Error('first attempt failed'))
        .mockResolvedValueOnce('step-1 recovered'),
    };
    const runner = new WorkflowRunner({
      cwd: createWorkspace(),
      db,
      executor,
    });

    const run = await runner.execute(
      makeConfig({ tokenBudget: 100, maxTokens: 80, retries: 1 }),
      'default'
    );
    const steps = await db.getStepsByRunId(run.id);

    expect(run.status).toBe('failed');
    expect(executor.executeAgentStep).toHaveBeenCalledTimes(2);
    expect(steps.find((step) => step.stepName === 'step-1')?.status).toBe('completed');
    expect(steps.find((step) => step.stepName === 'step-2')?.completionReason).toBe(
      'failed_budget_exceeded'
    );
    expect(steps.find((step) => step.stepName === 'step-2')?.error).toContain(
      'Workflow exceeded workflow budget'
    );
  });
});
