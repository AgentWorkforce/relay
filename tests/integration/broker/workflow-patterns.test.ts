/**
 * WorkflowRunner pattern and run behavior integration tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { workflow, type RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness } from './utils/workflow-harness.js';
import { assertRunCompleted, assertStepCompleted, assertStepOrder } from './utils/workflow-assert-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

function makeConfig(overrides?: Partial<RelayYamlConfig>): RelayYamlConfig {
  const base: RelayYamlConfig = {
    version: '1',
    name: 'test-workflow-patterns',
    description: 'Integration test',
    swarm: { pattern: 'fan-out' },
    agents: [
      { name: 'coordinator', cli: 'claude' },
      { name: 'worker-a', cli: 'claude' },
      { name: 'worker-b', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', agent: 'coordinator', task: 'Start' },
          { name: 'step-b', agent: 'worker-a', task: 'Branch A', dependsOn: ['step-a'] },
          { name: 'step-c', agent: 'worker-b', task: 'Branch B', dependsOn: ['step-a'] },
          { name: 'step-d', agent: 'coordinator', task: 'Merge', dependsOn: ['step-b', 'step-c'] },
        ],
      },
    ],
  };

  return {
    ...base,
    ...overrides,
    agents: overrides?.agents ?? base.agents,
    workflows: overrides?.workflows ?? base.workflows,
    swarm: { ...base.swarm, ...(overrides?.swarm ?? {}) },
  };
}

function createWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-patterns-'));
}

test('workflow-patterns: fan-out pattern executes diamond workflow', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepCompleted(result, 'step-c');
    assertStepCompleted(result, 'step-d');
    assertStepOrder(result, ['step-a', 'step-b', 'step-d']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: builder-generated config executes correctly', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const built = workflow('builder-pattern')
      .pattern('fan-out')
      .agent('coordinator', { cli: 'claude' })
      .agent('worker-a', { cli: 'claude' })
      .agent('worker-b', { cli: 'claude' })
      .step('step-a', { agent: 'coordinator', task: 'Start fan-out' })
      .step('step-b', { agent: 'worker-a', task: 'Branch A', dependsOn: ['step-a'] })
      .step('step-c', { agent: 'worker-b', task: 'Branch B', dependsOn: ['step-a'] })
      .step('step-d', {
        agent: 'coordinator',
        task: 'Merge branches',
        dependsOn: ['step-b', 'step-c'],
      })
      .toConfig();

    const result = await harness.runWorkflow(built, undefined, { cwd });
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepCompleted(result, 'step-c');
    assertStepCompleted(result, 'step-d');
    assertStepOrder(result, ['step-a', 'step-b', 'step-d']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: fan-out supports maxConcurrency config', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(
      {
        ...makeConfig(),
        swarm: { pattern: 'fan-out', maxConcurrency: 2 },
        agents: [
          { name: 'coordinator', cli: 'claude' },
          { name: 'worker-a', cli: 'claude' },
          { name: 'worker-b', cli: 'claude' },
          { name: 'worker-c', cli: 'claude' },
        ],
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'step-a', agent: 'coordinator', task: 'Start' },
              { name: 'step-b', agent: 'worker-a', task: 'Branch A', dependsOn: ['step-a'] },
              { name: 'step-c', agent: 'worker-b', task: 'Branch B', dependsOn: ['step-a'] },
              { name: 'step-d', agent: 'worker-c', task: 'Branch C', dependsOn: ['step-a'] },
              {
                name: 'step-e',
                agent: 'coordinator',
                task: 'Done',
                dependsOn: ['step-b', 'step-c', 'step-d'],
              },
            ],
          },
        ],
      },
      undefined,
      { cwd }
    );

    assertRunCompleted(result);
    assertStepCompleted(result, 'step-e');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
