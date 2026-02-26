/**
 * WorkflowRunner output-chaining integration tests.
 *
 * Verifies interpolation from step outputs and top-level variables across
 * deterministic and agent steps, including unresolved reference behavior.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { RelayYamlConfig, VariableContext } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness } from './utils/workflow-harness.js';
import {
  assertRunCompleted,
  assertStepCompleted,
  assertStepOutput,
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
    name: 'test-output-chaining',
    description: 'Integration test for output chaining',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', type: 'deterministic', command: 'printf "%s" "default"', captureOutput: true },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-chain-'));
}

test(
  'output-chaining: {{steps.step-a.output}} resolves in downstream deterministic step',
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
                  name: 'step-a',
                  type: 'deterministic',
                  command: 'printf "%s" "hop-value"',
                  captureOutput: true,
                },
                {
                  name: 'step-b',
                  type: 'deterministic',
                  command: 'printf "%s" "got-{{steps.step-a.output}}"',
                  dependsOn: ['step-a'],
                  captureOutput: true,
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
      assertStepOutput(result, 'step-a', 'hop-value');
      assertStepOutput(result, 'step-b', 'got-hop-value');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test('output-chaining: outputs compose across three-step A→B→C chain', { timeout: 120_000 }, async (t) => {
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
                name: 'step-a',
                type: 'deterministic',
                command: 'printf "%s" "A"',
                captureOutput: true,
              },
              {
                name: 'step-b',
                type: 'deterministic',
                command: 'printf "%s" "B-{{steps.step-a.output}}"',
                dependsOn: ['step-a'],
                captureOutput: true,
              },
              {
                name: 'step-c',
                type: 'deterministic',
                command: 'printf "%s" "C-{{steps.step-b.output}}"',
                dependsOn: ['step-b'],
                captureOutput: true,
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
    assertStepOutput(result, 'step-b', 'B-A');
    assertStepOutput(result, 'step-c', 'C-B-A');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test(
  'output-chaining: top-level vars are available in command interpolation',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    const vars: VariableContext = { projectName: 'relay-test' };

    try {
      const result = await harness.runWorkflow(
        makeConfig({
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'step-a',
                  type: 'deterministic',
                  command: 'printf "%s" "project:{{projectName}}"',
                  captureOutput: true,
                },
              ],
            },
          ],
        }),
        vars,
        { cwd }
      );

      assertRunCompleted(result);
      assertStepCompleted(result, 'step-a');
      assertStepOutput(result, 'step-a', 'project:relay-test');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test(
  'output-chaining: deterministic output feeds downstream agent task text',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    try {
      const result = await harness.runWorkflow(
        makeConfig({
          agents: [{ name: 'worker', cli: 'claude' }],
          workflows: [
            {
              name: 'default',
              steps: [
                {
                  name: 'step-a',
                  type: 'deterministic',
                  command: 'printf "%s" "agent-input"',
                  captureOutput: true,
                },
                {
                  name: 'step-b',
                  agent: 'worker',
                  task: 'Process this: {{steps.step-a.output}}',
                  dependsOn: ['step-a'],
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
      assertStepCompleted(result, 'step-a');
      assertStepCompleted(result, 'step-b');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test('output-chaining: unresolved reference is left as a literal', { timeout: 120_000 }, async (t) => {
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
                name: 'step-a',
                type: 'deterministic',
                command: 'printf "%s" "{{steps.nonexistent.output}}"',
                captureOutput: true,
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
    assertStepOutput(result, 'step-a', '{{steps.nonexistent.output}}');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
