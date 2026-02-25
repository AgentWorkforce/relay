/**
 * WorkflowRunner DAG behavior integration tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness } from './utils/workflow-harness.js';
import {
  assertStepCompleted,
  assertStepOrder,
  assertStepsParallel,
  assertWorkflowEventOrder,
} from './utils/workflow-assert-helpers.js';

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
    name: 'test-workflow-dag',
    description: 'Integration test',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', agent: 'worker', task: 'Step A' },
          { name: 'step-b', agent: 'worker', task: 'Step B', dependsOn: ['step-a'] },
          { name: 'step-c', agent: 'worker', task: 'Step C', dependsOn: ['step-b'] },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-dag-'));
}

test('workflow-dag: executes simple chain in order', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepCompleted(result, 'step-c');
    assertStepOrder(result, ['step-a', 'step-b', 'step-c']);
    assertWorkflowEventOrder(result.events, [
      'run:started',
      'step:started',
      'step:completed',
      'run:completed',
    ]);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test(
  'workflow-dag: runs parallel fan-in steps without ordering violations',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    try {
      const result = await harness.runWorkflow(
        makeConfig({
          workflows: [
            {
              name: 'default',
              steps: [
                { name: 'step-a', agent: 'worker', task: 'A' },
                { name: 'step-b', agent: 'worker', task: 'B' },
                {
                  name: 'step-c',
                  agent: 'worker',
                  task: 'C',
                  dependsOn: ['step-a', 'step-b'],
                },
              ],
            },
          ],
        }),
        undefined,
        { cwd }
      );

      assertStepCompleted(result, 'step-c');
      assertStepsParallel(result, ['step-a', 'step-b']);
      const cStart = result.events.findIndex(
        (event) => event.type === 'step:started' && 'stepName' in event && event.stepName === 'step-c'
      );
      const aDone = result.events.findIndex(
        (event) => event.type === 'step:completed' && 'stepName' in event && event.stepName === 'step-a'
      );
      const bDone = result.events.findIndex(
        (event) => event.type === 'step:completed' && 'stepName' in event && event.stepName === 'step-b'
      );
      assert.ok(cStart > aDone, 'step-c should start after step-a completes');
      assert.ok(cStart > bDone, 'step-c should start after step-b completes');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test('workflow-dag: supports diamond dependencies (A→B,C→D)', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'step-a', agent: 'worker', task: 'A' },
              { name: 'step-b', agent: 'worker', task: 'B', dependsOn: ['step-a'] },
              { name: 'step-c', agent: 'worker', task: 'C', dependsOn: ['step-a'] },
              { name: 'step-d', agent: 'worker', task: 'D', dependsOn: ['step-b', 'step-c'] },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    assertStepCompleted(result, 'step-d');
    assertStepsParallel(result, ['step-b', 'step-c']);
    const dStart = result.events.findIndex(
      (event) => event.type === 'step:started' && 'stepName' in event && event.stepName === 'step-d'
    );
    const bDone = result.events.findIndex(
      (event) => event.type === 'step:completed' && 'stepName' in event && event.stepName === 'step-b'
    );
    const cDone = result.events.findIndex(
      (event) => event.type === 'step:completed' && 'stepName' in event && event.stepName === 'step-c'
    );
    assert.ok(dStart > bDone, 'step-d should start after step-b completes');
    assert.ok(dStart > cDone, 'step-d should start after step-c completes');
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepCompleted(result, 'step-c');
    assertStepCompleted(result, 'step-d');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-dag: detects dependency cycle', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    await assert.rejects(
      () =>
        harness.runWorkflow(
          makeConfig({
            workflows: [
              {
                name: 'default',
                steps: [
                  { name: 'step-a', agent: 'worker', task: 'A', dependsOn: ['step-c'] },
                  { name: 'step-b', agent: 'worker', task: 'B', dependsOn: ['step-a'] },
                  { name: 'step-c', agent: 'worker', task: 'C', dependsOn: ['step-b'] },
                ],
              },
            ],
          }),
          undefined,
          { cwd }
        ),
      /dependency cycle/
    );
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
