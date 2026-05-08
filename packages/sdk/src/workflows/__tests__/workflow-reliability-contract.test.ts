import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowRunner, type WorkflowDb } from '../runner.js';
import type { RelayYamlConfig, WorkflowRunRow, WorkflowStepRow } from '../types.js';

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
    getStepsByRunId: vi.fn(async (runId: string) =>
      [...steps.values()].filter((step) => step.runId === runId).map((step) => ({ ...step }))
    ),
  };
}

function baseConfig(overrides: Partial<RelayYamlConfig> = {}): RelayYamlConfig {
  return {
    version: '1',
    name: 'workflow-reliability-contract',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'fixer', cli: 'claude', role: 'implementation engineer', interactive: false }],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'verify',
            type: 'deterministic',
            command: 'verify',
            captureOutput: true,
          },
        ],
      },
    ],
    trajectories: false,
    ...overrides,
  };
}

describe('workflow reliability contract', () => {
  it('routes repairable deterministic failures through a repair agent before retrying', async () => {
    const executeDeterministicStep = vi
      .fn()
      .mockResolvedValueOnce({ output: 'missing generated artifact', exitCode: 1 })
      .mockResolvedValueOnce({ output: 'artifact exists', exitCode: 0 });
    const executeAgentStep = vi.fn(async () => 'created generated artifact');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        errorHandling: { strategy: 'retry', repairRetries: 1, retryDelayMs: 1, repairAgent: 'fixer' },
      }),
      'default'
    );

    expect(run.status, run.error).toBe('completed');
    expect(executeAgentStep).toHaveBeenCalledTimes(1);
    expect((executeAgentStep as any).mock.calls[0][2]).toContain('A deterministic workflow gate failed');
    expect(executeDeterministicStep).toHaveBeenCalledTimes(2);
  });

  it('still retries the deterministic gate when the repair agent attempt throws', async () => {
    const executeDeterministicStep = vi
      .fn()
      .mockResolvedValueOnce({ output: 'transient failure', exitCode: 1 })
      .mockResolvedValueOnce({ output: 'passed after retry', exitCode: 0 });
    const executeAgentStep = vi.fn(async () => {
      throw new Error('repair model unavailable');
    });
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        errorHandling: { strategy: 'retry', repairRetries: 1, retryDelayMs: 1, repairAgent: 'fixer' },
      }),
      'default'
    );

    expect(run.status, run.error).toBe('completed');
    expect(executeAgentStep).toHaveBeenCalledTimes(1);
    expect(executeDeterministicStep).toHaveBeenCalledTimes(2);
  });

  it('fails only after the deterministic repair retry budget is exhausted', async () => {
    const executeDeterministicStep = vi.fn(async () => ({ output: 'still broken', exitCode: 1 }));
    const executeAgentStep = vi.fn(async () => 'attempted repair');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        errorHandling: { strategy: 'retry', repairRetries: 2, retryDelayMs: 1, repairAgent: 'fixer' },
      }),
      'default'
    );

    expect(run.status).toBe('failed');
    expect(run.error).toContain('verify');
    expect(executeAgentStep).toHaveBeenCalledTimes(2);
    expect(executeDeterministicStep).toHaveBeenCalledTimes(3);
  });

  it('keeps soft deterministic checks non-terminal so a later agent step can fix them', async () => {
    const executeDeterministicStep = vi.fn(async () => ({ output: 'typecheck failed', exitCode: 1 }));
    const executeAgentStep = vi.fn(async () => 'fixed typecheck');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'soft-validation',
                type: 'deterministic',
                command: 'npm run typecheck',
                captureOutput: true,
                failOnError: false,
              },
              {
                name: 'fix-validation',
                agent: 'fixer',
                task: 'Fix validation using {{steps.soft-validation.output}}',
                dependsOn: ['soft-validation'],
              },
            ],
          },
        ],
      }),
      'default'
    );

    expect(run.status, run.error).toBe('completed');
    expect(executeAgentStep).toHaveBeenCalledTimes(1);
    expect((executeAgentStep as any).mock.calls[0][2]).toContain('typecheck failed');
  });

  it('treats final hard validation as repairable before terminal failure', async () => {
    const executeDeterministicStep = vi
      .fn()
      .mockResolvedValueOnce({ output: 'final typecheck failed', exitCode: 1 })
      .mockResolvedValueOnce({ output: 'final validation passed', exitCode: 0 });
    const executeAgentStep = vi.fn(async () => 'fixed final validation');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        errorHandling: { strategy: 'retry', repairRetries: 1, retryDelayMs: 1, repairAgent: 'fixer' },
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'final-hard-validation',
                type: 'deterministic',
                command: 'npm run typecheck && npm test',
                captureOutput: true,
                failOnError: true,
              },
            ],
          },
        ],
      }),
      'default'
    );

    expect(run.status, run.error).toBe('completed');
    expect(executeAgentStep).toHaveBeenCalledTimes(1);
    expect((executeAgentStep as any).mock.calls[0][2]).toContain('final-hard-validation');
    expect(executeDeterministicStep).toHaveBeenCalledTimes(2);
  });

  it('keeps sibling branches independent when one branch captures a soft failure for repair', async () => {
    const executeDeterministicStep = vi.fn(async (_step, command: string) => {
      if (command === 'branch-a-soft-check') return { output: 'branch A needs repair', exitCode: 1 };
      return { output: `${command} ok`, exitCode: 0 };
    });
    const executeAgentStep = vi.fn(async () => 'merged branch evidence and fixed branch A');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        swarm: { pattern: 'fan-out' },
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'branch-a-validation',
                type: 'deterministic',
                command: 'branch-a-soft-check',
                captureOutput: true,
                failOnError: false,
              },
              {
                name: 'branch-b-validation',
                type: 'deterministic',
                command: 'branch-b-check',
                captureOutput: true,
                failOnError: true,
              },
              {
                name: 'merge-and-fix',
                agent: 'fixer',
                task: 'Use {{steps.branch-a-validation.output}} and {{steps.branch-b-validation.output}}.',
                dependsOn: ['branch-a-validation', 'branch-b-validation'],
              },
            ],
          },
        ],
      }),
      'default'
    );

    expect(run.status, run.error).toBe('completed');
    expect(executeDeterministicStep).toHaveBeenCalledTimes(2);
    expect(executeAgentStep).toHaveBeenCalledTimes(1);
    expect((executeAgentStep as any).mock.calls[0][2]).toContain('branch A needs repair');
    expect((executeAgentStep as any).mock.calls[0][2]).toContain('branch-b-check ok');
  });

  it('uses the best available workflow agent when no explicit repairAgent is configured', async () => {
    const executeDeterministicStep = vi
      .fn()
      .mockResolvedValueOnce({ output: 'needs repair', exitCode: 1 })
      .mockResolvedValueOnce({ output: 'fixed', exitCode: 0 });
    const executeAgentStep = vi.fn(async () => 'fixed by fallback agent');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        errorHandling: { strategy: 'retry', repairRetries: 1, retryDelayMs: 1 },
        agents: [
          { name: 'reviewer', cli: 'claude', role: 'reviewer' },
          { name: 'implementer', cli: 'claude', role: 'implementation engineer', interactive: false },
        ],
      }),
      'default'
    );

    expect(run.status, run.error).toBe('completed');
    expect((executeAgentStep as any).mock.calls[0][1]).toMatchObject({ name: 'implementer' });
  });

  it('falls back to a suitable workflow agent when the configured repairAgent is invalid', async () => {
    const executeDeterministicStep = vi
      .fn()
      .mockResolvedValueOnce({ output: 'needs repair', exitCode: 1 })
      .mockResolvedValueOnce({ output: 'fixed', exitCode: 0 });
    const executeAgentStep = vi.fn(async () => 'fixed by fallback agent');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(
      baseConfig({
        errorHandling: {
          strategy: 'retry',
          repairRetries: 1,
          retryDelayMs: 1,
          repairAgent: 'missing-repair-agent',
        },
      }),
      'default'
    );

    expect(run.status, run.error).toBe('completed');
    expect((executeAgentStep as any).mock.calls[0][1]).toMatchObject({ name: 'fixer' });
  });

  it('preserves cached step output when resuming from a later repair step', async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'relay-reliability-start-from-'));
    const previousRunId = 'previous-run-with-soft-validation';
    const outputDir = path.join(tmpDir, '.agent-relay', 'step-outputs', previousRunId);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, 'soft-validation.md'), 'cached typecheck failure');

    const executeAgentStep = vi.fn(async () => 'fixed cached validation failure');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: tmpDir,
      executor: { executeAgentStep },
    });

    try {
      const run = await runner.execute(
        baseConfig({
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'soft-validation',
                  type: 'deterministic',
                  command: 'npm run typecheck',
                  captureOutput: true,
                  failOnError: false,
                },
                {
                  name: 'fix-validation',
                  agent: 'fixer',
                  task: 'Fix this prior output: {{steps.soft-validation.output}}',
                  dependsOn: ['soft-validation'],
                },
              ],
            },
          ],
        }),
        'default',
        undefined,
        { startFrom: 'fix-validation', previousRunId }
      );

      expect(run.status, run.error).toBe('completed');
      expect(executeAgentStep).toHaveBeenCalledTimes(1);
      expect((executeAgentStep as any).mock.calls[0][2]).toContain('cached typecheck failure');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not run repair agents for fail-fast workflows even when agents are present', async () => {
    const executeDeterministicStep = vi.fn(async () => ({ output: 'hard failure', exitCode: 1 }));
    const executeAgentStep = vi.fn(async () => 'unexpected repair');
    const runner = new WorkflowRunner({
      db: makeDb(),
      workspaceId: 'ws-test',
      cwd: process.cwd(),
      executor: { executeDeterministicStep, executeAgentStep },
    });

    const run = await runner.execute(baseConfig({ errorHandling: { strategy: 'fail-fast' } }), 'default');

    expect(run.status).toBe('failed');
    expect(executeAgentStep).not.toHaveBeenCalled();
    expect(executeDeterministicStep).toHaveBeenCalledTimes(1);
  });
});
