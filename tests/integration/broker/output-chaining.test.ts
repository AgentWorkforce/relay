/**
 * WorkflowRunner output-chaining integration tests.
 *
 * Tests that {{steps.X.output}} and {{varName}} interpolation works correctly
 * across single-hop, multi-hop, top-level vars, deterministic→agent, and
 * unresolved-reference scenarios.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/output-chaining.test.js
 *
 * No special environment variables required (auto-provisions ephemeral workspace).
 */
import assert from 'node:assert/strict';
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

// ── Test 1: Single-hop interpolation ─────────────────────────────────────────

test(
  'output-chaining: single-hop {{steps.step-a.output}} resolves in downstream step',
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

// ── Test 2: Multi-hop A→B→C interpolation ────────────────────────────────────

test('output-chaining: multi-hop A→B→C chains outputs through all steps', { timeout: 120_000 }, async (t) => {
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

    // B receives A's value and prepends "B-"
    assertStepOutput(result, 'step-b', 'B-A');
    // C receives B's value ("B-A") and prepends "C-"
    assertStepOutput(result, 'step-c', 'C-B-A');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

// ── Test 3: Top-level vars substitution ──────────────────────────────────────

test(
  'output-chaining: top-level vars {{varName}} substituted into step command',
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

// ── Test 4: Deterministic output injected into agent task ─────────────────────

test(
  'output-chaining: deterministic step output flows into downstream agent task',
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
                  // Agent step receives chained output in its task.
                  // The fake-CLI shim outputs $FAKE_OUTPUT (default: "DONE") regardless of task content.
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

      // step-a should have produced the expected deterministic output
      assertStepOutput(result, 'step-a', 'agent-input');
      // step-b (agent) should have completed with DONE from the fake shim
      assertStepOutput(result, 'step-b', 'DONE');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

// ── Test 5: Unresolved reference is preserved as literal (graceful handling) ──

test(
  'output-chaining: unresolved {{steps.nonexistent.output}} is left as literal text',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    try {
      // Reference a step that doesn't exist in the workflow.
      // The runner leaves it as-is rather than failing — graceful non-error handling.
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

      // Run completes — unresolved references do not cause a fatal error
      assertRunCompleted(result);
      assertStepCompleted(result, 'step-a');

      // The unresolved placeholder is preserved literally in the output
      assertStepOutput(result, 'step-a', '{{steps.nonexistent.output}}');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);
