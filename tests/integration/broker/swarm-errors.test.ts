/**
 * Swarm error-handling integration tests.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness } from './utils/workflow-runner-harness.js';
import {
  assertRunCompleted,
  assertRunFailed,
  assertStepCompleted,
  assertStepFailed,
  assertStepOutput,
  assertStepRetried,
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

function installFlakyClaudeScript(
  harness: WorkflowRunnerHarness,
  counterFile: string,
  failures: number
): void {
  const fakeCliPath = harness.getRelayEnv().PATH?.split(path.delimiter)[0];
  assert.ok(fakeCliPath, 'Expected fake CLI directory in PATH');

  const script = `#!/usr/bin/env bash
COUNT_FILE=${JSON.stringify(counterFile)}
FAILURES=${JSON.stringify(String(failures))}
COUNT=0
if [ -f "$COUNT_FILE" ]; then
  COUNT=$(cat "$COUNT_FILE")
fi
COUNT=$((COUNT + 1))
printf '%s\n' "$COUNT" > "$COUNT_FILE"
if [ "$COUNT" -le "$FAILURES" ]; then
  echo "temporary failure $COUNT" >&2
  exit 1
fi
echo "DONE"
`;

  const claudePath = path.join(fakeCliPath, 'claude');
  fs.writeFileSync(claudePath, script, { mode: 0o755 });
}

test('swarm-errors: retries in strategy retry until success', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  const counterFile = path.join(cwd, 'agent-attempts.txt');
  installFlakyClaudeScript(harness, counterFile, 2);

  try {
    const result = await harness.runWorkflow(
      makeConfig({
        errorHandling: {
          strategy: 'retry',
          maxRetries: 2,
          retryDelayMs: 0,
        },
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-retry',
                agent: 'worker',
                task: 'intermittent agent task',
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

    const retryEvent = assertStepRetried(result, 'step-retry', 2);
    assert.equal(
      retryEvent.attempt,
      2,
      `Expected final retry attempt to be 2 for 2 failures, got ${retryEvent.attempt}`
    );

    const attempts = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
    assert.equal(attempts, 3, `Expected exactly 3 attempts, saw ${attempts}`);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('swarm-errors: fail-fast aborts workflow after first failure', { timeout: 120_000 }, async (t) => {
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
                name: 'step-setup',
                type: 'deterministic',
                command: 'echo SETUP_OK',
              },
              {
                name: 'step-fail',
                type: 'deterministic',
                command: 'echo FAILING && exit 1',
                dependsOn: ['step-setup'],
              },
              {
                name: 'step-skipped',
                type: 'deterministic',
                command: 'echo SHOULD_NOT_RUN',
                dependsOn: ['step-fail'],
              },
              {
                name: 'step-ok',
                type: 'deterministic',
                command: 'echo OK',
                dependsOn: ['step-setup'],
              },
              {
                name: 'step-blocked',
                type: 'deterministic',
                command: 'echo BLOCKED',
                dependsOn: ['step-ok'],
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
    assertStepSkipped(result, 'step-skipped');

    const blockedCompleted = result.events.find(
      (event) => event.type === 'step:completed' && 'stepName' in event && event.stepName === 'step-blocked'
    );
    assert.ok(!blockedCompleted, 'Expected step-blocked not to complete in fail-fast mode');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('swarm-errors: maxIterations loops until success within 3 attempts', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();
  const counterFile = path.join(cwd, 'agent-attempts.txt');
  installFlakyClaudeScript(harness, counterFile, 2);

  try {
    const result = await harness.runWorkflow(
      makeConfig({
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-loop',
                retries: 2,
                maxIterations: 3,
                agent: 'worker',
                task: 'bounded loop step',
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
    assertStepOutput(result, 'step-loop', 'DONE');

    const retryEvent = assertStepRetried(result, 'step-loop', 2);
    assert.equal(
      retryEvent.attempt,
      2,
      `Expected maxIterations loop to attempt retries up to 2 for 3 total attempts, got ${retryEvent.attempt}`
    );

    const attempts = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10);
    assert.equal(attempts, 3, `Expected exactly 3 attempts for maxIterations=3, saw ${attempts}`);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
