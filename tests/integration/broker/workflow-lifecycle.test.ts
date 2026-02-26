/**
 * WorkflowRunner lifecycle integration tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RelayYamlConfig, VerificationCheck } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness } from './utils/workflow-harness.js';
import {
  assertRunCompleted,
  assertRunFailed,
  assertStepCompleted,
  assertStepFailed,
  assertWorkflowEventOrder,
} from './utils/workflow-assert-helpers.js';
import { sleep } from './utils/cli-helpers.js';

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
    name: 'test-workflow-lifecycle',
    description: 'Integration test',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [{ name: 'step-1', agent: 'worker', task: 'Do one thing' }],
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-lifecycle-'));
}

test('workflow-lifecycle: run completes successfully', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-1');
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

test('workflow-lifecycle: failed run emits failed events', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  const failingVerification: VerificationCheck = {
    type: 'output_contains',
    value: 'MUST_NOT_APPEAR',
  };

  try {
    const result = await harness.runWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-1',
                agent: 'worker',
                task: 'Do one thing',
                verification: failingVerification,
              },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    assertRunFailed(result);
    assertStepFailed(result, 'step-1');
    assertWorkflowEventOrder(result.events, ['run:started', 'step:started', 'step:failed', 'run:failed']);
    assert.equal(result.run.error !== undefined, true, 'Expected run error');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-lifecycle: abort cancels a running workflow', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const runPromise = harness.runWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-slow',
                type: 'deterministic',
                command: 'sleep 30',
              },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    let currentRunner = harness.getCurrentRunner();
    for (let i = 0; i < 20 && !currentRunner; i += 1) {
      await sleep(250);
      currentRunner = harness.getCurrentRunner();
    }
    assert.ok(currentRunner, 'Expected workflow runner to be available while running');
    currentRunner.abort();

    const result = await runPromise;
    assert.equal(result.run.status, 'cancelled', `Expected run to be cancelled, got "${result.run.status}"`);
    assert.ok(
      result.events.some((event) => event.type === 'run:cancelled'),
      'Expected run:cancelled event'
    );
    assert.ok(
      result.events.some((event) => event.type === 'step:failed'),
      'Expected abort to fail the in-flight step'
    );
    assertWorkflowEventOrder(result.events, ['run:started', 'step:started', 'step:failed', 'run:cancelled']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
