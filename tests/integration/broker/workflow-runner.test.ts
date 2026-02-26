/**
 * WorkflowRunner integration tests — five canonical scenarios exercised through
 * the WorkflowRunnerHarness + fake-CLI shim.
 *
 * 1. Single step  — minimal workflow completes
 * 2. Serial DAG   — two steps execute in dependency order
 * 3. Parallel fan — two independent steps run concurrently into one fan-in step
 * 4. Retry        — deterministic step retries on transient failure then succeeds
 * 5. Mixed        — deterministic (command) step and agent step in one workflow
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
  assertStepCount,
  assertStepOrder,
  assertStepOutput,
  assertStepRetried,
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
    name: 'test-workflow-runner',
    description: 'WorkflowRunner integration test',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [{ name: 'step-a', agent: 'worker', task: 'Do work' }],
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-runner-'));
}

// ── Test 1: Single step ────────────────────────────────────────────────────

test('workflow-runner: single step completes', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepOutput(result, 'step-a', 'DONE');
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

// ── Test 2: Serial DAG ────────────────────────────────────────────────────

test('workflow-runner: serial dag executes steps in dependency order', { timeout: 120_000 }, async (t) => {
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
              { name: 'step-a', agent: 'worker', task: 'Step A' },
              { name: 'step-b', agent: 'worker', task: 'Step B', dependsOn: ['step-a'] },
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
    assertStepOrder(result, ['step-a', 'step-b']);
    assertStepCount(result, 'completed', 2);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

// ── Test 3: Parallel fan ──────────────────────────────────────────────────

test('workflow-runner: parallel fan-out steps converge into fan-in step', { timeout: 120_000 }, async (t) => {
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
              { name: 'fan-a', agent: 'worker', task: 'Fan A' },
              { name: 'fan-b', agent: 'worker', task: 'Fan B' },
              {
                name: 'merge',
                agent: 'worker',
                task: 'Merge results',
                dependsOn: ['fan-a', 'fan-b'],
              },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    assertRunCompleted(result);
    assertStepsParallel(result, ['fan-a', 'fan-b']);
    assertStepCompleted(result, 'merge');

    // merge must start after both fan steps complete
    const mergeStart = result.events.findIndex(
      (event) => event.type === 'step:started' && 'stepName' in event && event.stepName === 'merge'
    );
    const fanADone = result.events.findIndex(
      (event) => event.type === 'step:completed' && 'stepName' in event && event.stepName === 'fan-a'
    );
    const fanBDone = result.events.findIndex(
      (event) => event.type === 'step:completed' && 'stepName' in event && event.stepName === 'fan-b'
    );

    assert.ok(mergeStart > fanADone, 'merge must start after fan-a completes');
    assert.ok(mergeStart > fanBDone, 'merge must start after fan-b completes');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

// ── Test 4: Retry on transient failure ────────────────────────────────────

test('workflow-runner: deterministic step retries on transient failure', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const marker = path.join(cwd, 'retry-marker.txt');
    const result = await harness.runWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-retry',
                type: 'deterministic',
                command: `if [ ! -f ${marker} ]; then touch ${marker}; exit 1; fi; echo DONE`,
                retries: 1,
                verification: { type: 'output_contains', value: 'DONE' },
              },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    assertRunCompleted(result);
    assertStepCompleted(result, 'step-retry');
    assertStepRetried(result, 'step-retry', 1);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

// ── Test 5: Deterministic + agent mix ────────────────────────────────────

test(
  'workflow-runner: mixes deterministic and agent steps in one workflow',
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
                {
                  name: 'prep',
                  type: 'deterministic',
                  command: 'echo PREPARED',
                  verification: { type: 'output_contains', value: 'PREPARED' },
                },
                {
                  name: 'agent-work',
                  agent: 'worker',
                  task: 'Do agent work after deterministic prep',
                  dependsOn: ['prep'],
                },
              ],
            },
          ],
        }),
        undefined,
        { cwd }
      );

      assertRunCompleted(result);
      assertStepCompleted(result, 'prep');
      assertStepCompleted(result, 'agent-work');
      assertStepOrder(result, ['prep', 'agent-work']);
      assertStepOutput(result, 'agent-work', 'DONE');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);
