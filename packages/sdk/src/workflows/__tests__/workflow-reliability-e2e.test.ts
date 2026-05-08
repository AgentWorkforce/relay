import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkflowRunner } from '../runner.js';
import type { AgentDefinition, RelayYamlConfig, WorkflowStep } from '../types.js';

const CHECK_MARKER =
  'node -e "const fs=require(\'fs\');const v=fs.readFileSync(\'marker.txt\',\'utf8\').trim();if(v!==\'fixed\'){console.log(\'marker=\'+v);process.exit(1)}console.log(\'ok\')"';

function baseConfig(
  name: string,
  pattern: RelayYamlConfig['swarm']['pattern'],
  steps: NonNullable<RelayYamlConfig['workflows']>[number]['steps']
): RelayYamlConfig {
  return {
    version: '1',
    name,
    swarm: { pattern },
    agents: [
      {
        name: 'fixer',
        cli: 'claude',
        role: 'implementation engineer',
        interactive: false,
      },
    ],
    workflows: [{ name: 'default', steps }],
    trajectories: false,
  };
}

function makeWorkspace(): string {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'relay-workflow-reliability-e2e-'));
  writeFileSync(path.join(cwd, 'marker.txt'), 'broken\n');
  return cwd;
}

async function runReliabilityWorkflow(config: RelayYamlConfig, cwd = makeWorkspace()) {
  const callsByStep = new Map<string, number>();
  const executeAgentStep = async (
    step: WorkflowStep,
    _agent: AgentDefinition,
    resolvedTask: string
  ): Promise<string> => {
    const count = (callsByStep.get(step.name) ?? 0) + 1;
    callsByStep.set(step.name, count);

    if (step.name.includes('-repair-')) {
      writeFileSync(path.join(step.cwd ?? cwd, 'marker.txt'), 'fixed\n');
      return `repair complete for ${step.name}`;
    }

    if (/invalid[- ]artifact/i.test(step.name) && count === 1) {
      return 'Execution: blocked — INVALID_ARTIFACT at final-hard-validation';
    }

    if (/child/i.test(resolvedTask) && count === 1) {
      return 'Execution: blocked — INVALID_ARTIFACT at final-hard-validation';
    }

    return `Execution: success\nRICKY_MASTER_CHILD_RUN_VERIFIED\n${resolvedTask.slice(0, 80)}`;
  };

  const runner = new WorkflowRunner({
    workspaceId: 'ws-e2e',
    cwd,
    executor: { executeAgentStep },
  });

  try {
    const run = await runner.execute(config, 'default');
    return { run, callsByStep };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('workflow reliability e2e shapes', () => {
  it('repairs a failing deterministic gate in a pipeline workflow', async () => {
    const { run, callsByStep } = await runReliabilityWorkflow(
      baseConfig('reliable-pipeline', 'pipeline', [
        { name: 'prepare', agent: 'fixer', task: 'Prepare inputs.' },
        {
          name: 'verify',
          type: 'deterministic',
          command: CHECK_MARKER,
          dependsOn: ['prepare'],
          captureOutput: true,
        },
      ])
    );

    expect(run.status, run.error).toBe('completed');
    expect(callsByStep.has('verify-repair-1')).toBe(true);
  });

  it('repairs a failing deterministic gate in a DAG workflow', async () => {
    const { run, callsByStep } = await runReliabilityWorkflow(
      baseConfig('reliable-dag', 'dag', [
        { name: 'backend', agent: 'fixer', task: 'Prepare backend evidence.' },
        { name: 'frontend', agent: 'fixer', task: 'Prepare frontend evidence.' },
        {
          name: 'integrated-validation',
          type: 'deterministic',
          command: CHECK_MARKER,
          dependsOn: ['backend', 'frontend'],
          captureOutput: true,
        },
      ])
    );

    expect(run.status, run.error).toBe('completed');
    expect(callsByStep.has('integrated-validation-repair-1')).toBe(true);
  });

  it('keeps fan-out siblings isolated while repairing the failed branch gate', async () => {
    const { run, callsByStep } = await runReliabilityWorkflow(
      baseConfig('reliable-fan-out', 'fan-out', [
        {
          name: 'branch-a-validation',
          type: 'deterministic',
          command: CHECK_MARKER,
          captureOutput: true,
        },
        {
          name: 'branch-b-validation',
          type: 'deterministic',
          command: 'node -e "console.log(\'branch-b-ok\')"',
          captureOutput: true,
        },
        {
          name: 'merge',
          agent: 'fixer',
          task: 'Merge {{steps.branch-a-validation.output}} and {{steps.branch-b-validation.output}}.',
          dependsOn: ['branch-a-validation', 'branch-b-validation'],
        },
      ])
    );

    expect(run.status, run.error).toBe('completed');
    expect(callsByStep.has('branch-a-validation-repair-1')).toBe(true);
    expect(callsByStep.has('branch-b-validation-repair-1')).toBe(false);
  });

  it('repairs child workflow INVALID_ARTIFACT output before master final validation', async () => {
    const { run, callsByStep } = await runReliabilityWorkflow(
      baseConfig('reliable-master-child', 'hierarchical', [
        {
          name: 'run-child-workflow',
          agent: 'fixer',
          task: 'Run child workflow and return RICKY_MASTER_CHILD_RUN_VERIFIED.',
          verification: {
            type: 'output_contains',
            value: 'RICKY_MASTER_CHILD_RUN_VERIFIED',
          },
        },
        {
          name: 'master-final-validation',
          type: 'deterministic',
          command: CHECK_MARKER,
          dependsOn: ['run-child-workflow'],
          captureOutput: true,
        },
      ])
    );

    expect(run.status, run.error).toBe('completed');
    expect(callsByStep.has('run-child-workflow-repair-1')).toBe(true);
    expect(callsByStep.has('master-final-validation-repair-1')).toBe(false);
  });

  it('repairs a deterministic-only workflow with a configured repair agent', async () => {
    const { run, callsByStep } = await runReliabilityWorkflow(
      baseConfig('reliable-deterministic-only', 'pipeline', [
        {
          name: 'verify-only',
          type: 'deterministic',
          command: CHECK_MARKER,
          captureOutput: true,
        },
      ])
    );

    expect(run.status, run.error).toBe('completed');
    expect(callsByStep.has('verify-only-repair-1')).toBe(true);
  });

  it('repairs agent artifact retries and then passes deterministic validation', async () => {
    const { run, callsByStep } = await runReliabilityWorkflow(
      baseConfig('reliable-agent-plus-gates', 'pipeline', [
        {
          name: 'invalid-artifact-author',
          agent: 'fixer',
          task: 'Produce structured artifact metadata.',
          verification: {
            type: 'output_contains',
            value: 'RICKY_MASTER_CHILD_RUN_VERIFIED',
          },
        },
        {
          name: 'verify-artifact',
          type: 'deterministic',
          command: CHECK_MARKER,
          dependsOn: ['invalid-artifact-author'],
          captureOutput: true,
        },
      ])
    );

    expect(run.status, run.error).toBe('completed');
    expect(callsByStep.has('invalid-artifact-author-repair-1')).toBe(true);
    expect(callsByStep.has('verify-artifact-repair-1')).toBe(false);
  });

  it('repairs validation inside a git worktree-backed workflow', async () => {
    const cwd = makeWorkspace();
    execSync('git init -q', { cwd });
    execSync('git config user.email test@example.com', { cwd });
    execSync('git config user.name "Relay Test"', { cwd });
    execSync('git add marker.txt && git commit -q -m init', { cwd });

    const { run, callsByStep } = await runReliabilityWorkflow(
      baseConfig('reliable-worktree', 'pipeline', [
        {
          name: 'make-worktree',
          type: 'worktree',
          branch: 'reliability-worktree-test',
          path: 'child-worktree',
        },
        {
          name: 'verify-in-worktree',
          type: 'deterministic',
          command: CHECK_MARKER,
          cwd: 'child-worktree',
          dependsOn: ['make-worktree'],
          captureOutput: true,
        },
      ]),
      cwd
    );

    expect(run.status, run.error).toBe('completed');
    expect(callsByStep.has('verify-in-worktree-repair-1')).toBe(true);
  });
});
