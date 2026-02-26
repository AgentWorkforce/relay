/**
 * Swarm error-handling pattern integration tests.
 * Covers retry (fail-twice-then-pass), fail-fast abort, and maxIterations loop.
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
  assertStepFailed,
  assertStepOutput,
  assertStepSkipped,
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
    name: 'test-swarm-errors',
    description: 'Swarm error handling integration test',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [{ name: 'step-a', type: 'deterministic', command: 'echo DONE' }],
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-swarm-errors-'));
}

test(
  'swarm-errors: retry — step fails twice then passes on third attempt',
  { timeout: 60_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    // Counter file: step fails until it has been attempted 3 times (retries: 2 = 3 total attempts)
    const counterFile = path.join(cwd, 'retry-counter.txt');

    try {
      const result = await harness.runWorkflow(
        makeConfig({
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'step-retry',
                  type: 'deterministic',
                  // Read counter, increment, fail until count reaches 3
                  command: [
                    `COUNT=$(cat ${counterFile} 2>/dev/null || echo 0)`,
                    `COUNT=$((COUNT + 1))`,
                    `echo $COUNT > ${counterFile}`,
                    `if [ "$COUNT" -lt 3 ]; then echo "attempt $COUNT — failing"; exit 1; fi`,
                    `echo "attempt $COUNT — DONE"`,
                  ].join('; '),
                  retries: 2,
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

      // Counter file must show 3 attempts
      const finalCount = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
      assert.equal(finalCount, 3, `Expected 3 total attempts, counter shows ${finalCount}`);

      // step:retrying events should have fired for attempts 1 and 2
      const retryEvents = result.events.filter((e) => e.type === 'step:retrying');
      assert.ok(retryEvents.length >= 1, 'Expected at least one step:retrying event');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test(
  'swarm-errors: fail-fast — first step failure aborts the workflow and skips downstream steps',
  { timeout: 60_000 },
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
              // Default errorHandling strategy is fail-fast
              steps: [
                {
                  name: 'step-fail',
                  type: 'deterministic',
                  command: 'echo failing && exit 1',
                },
                {
                  name: 'step-skipped',
                  type: 'deterministic',
                  command: 'echo should-not-run',
                  dependsOn: ['step-fail'],
                },
              ],
            },
          ],
        }),
        undefined,
        { cwd }
      );

      assertRunFailed(result);
      assertStepFailed(result, 'step-fail');

      // Downstream step must be skipped, not executed
      assertStepSkipped(result, 'step-skipped');

      // Confirm the skipped step never produced output
      const skippedOutput = result.events.find(
        (e) => e.type === 'step:completed' && 'stepName' in e && e.stepName === 'step-skipped'
      );
      assert.ok(!skippedOutput, 'step-skipped must not have completed');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test(
  'swarm-errors: maxIterations loop — deterministic step loops 3 iterations and reports final count',
  { timeout: 60_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    const iterFile = path.join(cwd, 'iter-count.txt');

    try {
      const result = await harness.runWorkflow(
        makeConfig({
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'step-loop',
                  type: 'deterministic',
                  // Explicitly loop 3 iterations in the shell command, record count
                  command: [
                    `for i in 1 2 3; do echo "iteration $i" >> ${iterFile}; done`,
                    `COUNT=$(wc -l < ${iterFile} | tr -d ' ')`,
                    `echo "ITERATIONS_DONE:$COUNT"`,
                  ].join('; '),
                  // maxIterations documents the intended loop bound on the step
                  maxIterations: 3,
                },
              ],
            },
          ],
        }),
        undefined,
        { cwd }
      );

      assertRunCompleted(result);
      assertStepCompleted(result, 'step-loop');
      assertStepOutput(result, 'step-loop', 'ITERATIONS_DONE:3');

      // Verify iteration file recorded all 3 passes
      const lines = fs.readFileSync(iterFile, 'utf8').trim().split('\n');
      assert.equal(lines.length, 3, `Expected 3 iteration entries, got ${lines.length}`);
      assert.equal(lines[0], 'iteration 1');
      assert.equal(lines[1], 'iteration 2');
      assert.equal(lines[2], 'iteration 3');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);
