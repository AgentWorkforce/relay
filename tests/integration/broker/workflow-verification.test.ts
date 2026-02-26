/**
 * WorkflowRunner verification check integration tests.
 */
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
    name: 'test-workflow-verification',
    description: 'Integration test',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'step-verify-output',
            agent: 'worker',
            task: 'Return DONE',
            verification: { type: 'output_contains', value: 'DONE' },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-verification-'));
}

test('workflow-verification: output_contains passes when text exists', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-verify-output');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-verification: output_contains fails when text missing', { timeout: 120_000 }, async (t) => {
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
                name: 'step-verify-output',
                agent: 'worker',
                task: 'Return DONE',
                verification: { type: 'output_contains', value: 'MISSING' },
              },
            ],
          },
        ],
      }),
      undefined,
      { cwd }
    );

    assertRunFailed(result, 'does not contain');
    assertStepFailed(result, 'step-verify-output');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test(
  'workflow-verification: exit_code check is accepted for interactive agents',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    try {
      const check: VerificationCheck = { type: 'exit_code', value: '0' };
      const result = await harness.runWorkflow(
        makeConfig({
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'step-verify-exit',
                  agent: 'worker',
                  task: 'Return DONE',
                  verification: check,
                },
              ],
            },
          ],
        }),
        undefined,
        { cwd }
      );

      assertRunCompleted(result);
      assertStepCompleted(result, 'step-verify-exit');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test('workflow-verification: file_exists passes when file is produced', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const marker = 'verify-marker.txt';
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(
      {
        ...makeConfig(),
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-make-file',
                type: 'deterministic',
                command: `printf "ok" > ${marker}`,
              },
              {
                name: 'step-file',
                agent: 'worker',
                task: 'Validate file exists',
                dependsOn: ['step-make-file'],
                verification: { type: 'file_exists', value: marker },
              },
            ],
          },
        ],
      },
      undefined,
      { cwd }
    );
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-file');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-verification: file_exists fails when file is missing', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(
      {
        ...makeConfig(),
        workflows: [
          {
            name: 'default',
            steps: [
              {
                name: 'step-file',
                agent: 'worker',
                task: 'Expect missing file',
                verification: { type: 'file_exists', value: 'missing-marker.txt' },
              },
            ],
          },
        ],
      },
      undefined,
      { cwd }
    );
    assertRunFailed(result, 'does not exist');
    assertStepFailed(result, 'step-file');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
