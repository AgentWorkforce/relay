/**
 * WorkflowRunner agent-interaction integration tests.
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
  assertRunFailed,
  assertStepCompleted,
  assertStepOutput,
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
    name: 'test-workflow-agents',
    description: 'Integration test',
    swarm: { pattern: 'dag' },
    agents: [
      { name: 'agent-a', cli: 'claude' },
      { name: 'agent-b', cli: 'claude' },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', agent: 'agent-a', task: 'Do agent-a work' },
          { name: 'step-b', agent: 'agent-b', task: 'Do agent-b work' },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-agents-'));
}

test('workflow-agents: runs steps for different agents', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepOutput(result, 'step-a', 'DONE');
    assertStepOutput(result, 'step-b', 'DONE');
    assertWorkflowEventOrder(result.events, [
      'run:started',
      'step:started',
      'step:completed',
      'run:completed',
    ]);
    assert.ok(result.brokerEvents.length > 0, 'Expected broker events from agent lifecycle');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-agents: emits agent spawn/release events', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    const eventKinds = new Set(result.brokerEvents.map((event) => event.kind));

    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepOutput(result, 'step-a', 'DONE');
    assertStepOutput(result, 'step-b', 'DONE');
    assertWorkflowEventOrder(result.events, [
      'run:started',
      'step:started',
      'step:completed',
      'run:completed',
    ]);
    assert.ok(eventKinds.has('agent_spawned'), 'Expected agent_spawned broker event');
    assert.ok(eventKinds.has('agent_released'), 'Expected agent_released broker event');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-agents: retries deterministic work on transient failure', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const marker = 'wf-retry-marker.txt';
    const result = await harness.runWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-retry',
                type: 'deterministic',
                command: `if [ ! -f ${marker} ]; then echo fail-once; touch ${marker}; exit 1; fi; echo DONE`,
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
    assertStepOutput(result, 'step-retry', 'DONE');
    const retrying = result.events.find((event) => event.type === 'step:retrying');
    assert.ok(retrying, 'Expected a retrying event');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-agents: surfaces deterministic agent failure', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();
  const previousOutput = process.env.FAKE_OUTPUT;

  try {
    process.env.FAKE_OUTPUT = 'ERROR';
    const result = await harness.runWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-a',
                agent: 'agent-a',
                task: 'Should fail verification',
                verification: { type: 'output_contains', value: 'DONE' },
              },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    assertRunFailed(result, 'does not contain');
    assertStepFailed(result, 'step-a');
  } finally {
    process.env.FAKE_OUTPUT = previousOutput;
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
