/**
 * Swarm DAG pattern integration tests.
 * Covers serial ordering, parallel fan-out, and maxConcurrency enforcement.
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
  assertRunCompleted,
  assertStepCompleted,
  assertStepOrder,
  assertStepsParallel,
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
    name: 'test-swarm-dag',
    description: 'Swarm DAG pattern integration test',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', type: 'deterministic', command: 'echo DONE_A' },
          {
            name: 'step-b',
            type: 'deterministic',
            command: 'echo DONE_B',
            dependsOn: ['step-a'],
          },
          {
            name: 'step-c',
            type: 'deterministic',
            command: 'echo DONE_C',
            dependsOn: ['step-b'],
          },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-swarm-dag-'));
}

test('swarm-dag: serial A→B→C executes in strict dependency order', { timeout: 60_000 }, async (t) => {
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

    // Verify strict serial ordering: A before B before C
    assertStepOrder(result, ['step-a', 'step-b', 'step-c']);

    // Verify timestamps: each step starts only after the prior step completes
    const completedA = result.events.findIndex(
      (e) => e.type === 'step:completed' && 'stepName' in e && e.stepName === 'step-a'
    );
    const startedB = result.events.findIndex(
      (e) => e.type === 'step:started' && 'stepName' in e && e.stepName === 'step-b'
    );
    const completedB = result.events.findIndex(
      (e) => e.type === 'step:completed' && 'stepName' in e && e.stepName === 'step-b'
    );
    const startedC = result.events.findIndex(
      (e) => e.type === 'step:started' && 'stepName' in e && e.stepName === 'step-c'
    );

    assert.ok(startedB > completedA, 'step-b must not start until step-a completes');
    assert.ok(startedC > completedB, 'step-c must not start until step-b completes');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('swarm-dag: parallel fan A→{B,C}→D starts B and C concurrently', { timeout: 60_000 }, async (t) => {
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
              { name: 'step-a', type: 'deterministic', command: 'echo DONE_A' },
              {
                name: 'step-b',
                type: 'deterministic',
                command: 'sleep 0.1 && echo DONE_B',
                dependsOn: ['step-a'],
              },
              {
                name: 'step-c',
                type: 'deterministic',
                command: 'sleep 0.1 && echo DONE_C',
                dependsOn: ['step-a'],
              },
              {
                name: 'step-d',
                type: 'deterministic',
                command: 'echo DONE_D',
                dependsOn: ['step-b', 'step-c'],
              },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepCompleted(result, 'step-c');
    assertStepCompleted(result, 'step-d');

    // A must complete before B and C start
    const completedA = result.events.findIndex(
      (e) => e.type === 'step:completed' && 'stepName' in e && e.stepName === 'step-a'
    );
    const startedB = result.events.findIndex(
      (e) => e.type === 'step:started' && 'stepName' in e && e.stepName === 'step-b'
    );
    const startedC = result.events.findIndex(
      (e) => e.type === 'step:started' && 'stepName' in e && e.stepName === 'step-c'
    );
    assert.ok(startedB > completedA, 'step-b must start after step-a completes');
    assert.ok(startedC > completedA, 'step-c must start after step-a completes');

    // B and C run concurrently — each starts before the other finishes
    assertStepsParallel(result, ['step-b', 'step-c']);

    // D must start only after both B and C complete
    const completedB = result.events.findIndex(
      (e) => e.type === 'step:completed' && 'stepName' in e && e.stepName === 'step-b'
    );
    const completedC = result.events.findIndex(
      (e) => e.type === 'step:completed' && 'stepName' in e && e.stepName === 'step-c'
    );
    const startedD = result.events.findIndex(
      (e) => e.type === 'step:started' && 'stepName' in e && e.stepName === 'step-d'
    );
    assert.ok(startedD > completedB, 'step-d must start after step-b completes');
    assert.ok(startedD > completedC, 'step-d must start after step-c completes');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test(
  'swarm-dag: maxConcurrency:2 limits parallel steps to at most 2 at once',
  { timeout: 60_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    try {
      // 4 independent steps all ready at once — maxConcurrency:2 should batch them 2-at-a-time
      const result = await harness.runWorkflow(
        {
          version: '1',
          name: 'test-swarm-dag-concurrency',
          description: 'maxConcurrency test',
          swarm: { pattern: 'dag', maxConcurrency: 2 },
          agents: [{ name: 'worker', cli: 'claude' }],
          workflows: [
            {
              name: 'default',
              steps: [
                { name: 'step-1', type: 'deterministic', command: 'sleep 0.05 && echo DONE_1' },
                { name: 'step-2', type: 'deterministic', command: 'sleep 0.05 && echo DONE_2' },
                { name: 'step-3', type: 'deterministic', command: 'sleep 0.05 && echo DONE_3' },
                { name: 'step-4', type: 'deterministic', command: 'sleep 0.05 && echo DONE_4' },
              ],
            },
          ],
        },
        undefined,
        { cwd }
      );

      assertRunCompleted(result);
      assertStepCompleted(result, 'step-1');
      assertStepCompleted(result, 'step-2');
      assertStepCompleted(result, 'step-3');
      assertStepCompleted(result, 'step-4');

      // Verify no more than 2 steps were active simultaneously by scanning the event stream
      let activeCount = 0;
      let maxActive = 0;
      for (const event of result.events) {
        if (event.type === 'step:started') {
          activeCount += 1;
          maxActive = Math.max(maxActive, activeCount);
        } else if (
          event.type === 'step:completed' ||
          event.type === 'step:failed' ||
          event.type === 'step:skipped'
        ) {
          activeCount -= 1;
        }
      }
      assert.ok(
        maxActive <= 2,
        `Expected at most 2 concurrent steps, but saw ${maxActive} simultaneously active`
      );
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);
