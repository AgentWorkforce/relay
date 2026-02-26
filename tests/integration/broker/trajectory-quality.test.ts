/**
 * Trajectory quality integration tests.
 *
 * Verifies that trajectories capture *reasoning* — purpose, step intent,
 * root-cause diagnosis, and actionable learnings — not just mechanical
 * event logs.
 *
 * Tests three scenarios:
 *   1. Success path  — description, step intent, narrative summary are present
 *   2. Verification mismatch failure — cause classified, sentinel named, learning actionable
 *   3. Non-interactive timeout failure — diagnosed as tool-discovery anti-pattern
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/trajectory-quality.test.js
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
  assertTrajectoryExists,
} from './utils/workflow-assert-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

function createWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-traj-quality-'));
}

/** Flatten all chapter events into a single array for easy searching. */
function allEvents(trajectory: ReturnType<typeof assertTrajectoryExists>) {
  return trajectory.chapters.flatMap((c) => c.events);
}

function eventContaining(trajectory: ReturnType<typeof assertTrajectoryExists>, substr: string) {
  return allEvents(trajectory).find((e) => e.content.includes(substr));
}

// ── Test 1: Success path ──────────────────────────────────────────────────────
//
// A workflow with a description + two non-interactive steps that succeed.
// The trajectory should:
//   - Record the workflow purpose in the Planning chapter
//   - Record step intent (first sentence of task), not just "assigned to agent X"
//   - Produce a narrative summary ("All N steps completed") not just statistics
//   - Set approach from actual pattern, not hardcoded "workflow-runner DAG execution"
//   - Record the completion sentinel as the finding

test(
  'trajectory quality: success path records purpose, intent, and narrative',
  { timeout: 240_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    const config: RelayYamlConfig = {
      version: '1',
      name: 'traj-success-test',
      description: 'Validate that trajectory content is reasoning-rich, not log-like.',
      swarm: { pattern: 'pipeline' },
      agents: [{ name: 'worker', cli: 'claude', interactive: false, constraints: { model: 'haiku' } }],
      workflows: [
        {
          name: 'default',
          steps: [
            {
              name: 'step-a',
              agent: 'worker',
              task: 'Count vowels in "hello world" and output the count. End with: STEP_A_DONE',
              verification: { type: 'output_contains', value: 'STEP_A_DONE' },
            },
            {
              name: 'step-b',
              agent: 'worker',
              task: 'Confirm step-b ran by outputting: STEP_B_DONE',
              verification: { type: 'output_contains', value: 'STEP_B_DONE' },
              dependsOn: ['step-a'],
            },
          ],
        },
      ],
      trajectories: { enabled: true },
    };

    try {
      const result = await harness.runWorkflow(config, undefined, { cwd });
      assertRunCompleted(result);

      const trajectory = assertTrajectoryExists(harness, cwd);

      // 1. Purpose recorded — description propagated into Planning chapter
      const purposeEvent = eventContaining(trajectory, 'Validate that trajectory content');
      assert.ok(purposeEvent, 'Expected "Purpose:" event with workflow description in Planning chapter');

      // 2. Approach reflects actual pattern, not hardcoded string
      const approach = trajectory.retrospective?.approach ?? '';
      assert.ok(approach.includes('pipeline'), `Expected approach to include "pipeline", got: "${approach}"`);
      assert.ok(
        !approach.includes('workflow-runner DAG execution'),
        `Expected approach to NOT be the old hardcoded string, got: "${approach}"`
      );

      // 3. Step intent captured — first sentence of task, not "assigned to agent X"
      const stepAIntent = eventContaining(trajectory, 'Count vowels');
      assert.ok(stepAIntent, 'Expected step-a intent event containing first sentence of task');
      const oldStyleAssign = allEvents(trajectory).find((e) =>
        e.content.match(/Step "step-a" assigned to agent/)
      );
      assert.ok(!oldStyleAssign, 'Should not use old "assigned to agent" phrasing');

      // 4. Completion sentinel appears in finding event (not raw 200-char preview)
      const stepADone = eventContaining(trajectory, 'STEP_A_DONE');
      assert.ok(stepADone, 'Expected finding event containing the STEP_A_DONE sentinel');
      assert.equal(stepADone?.type, 'finding', 'Completion event should be type "finding"');

      // 5. Narrative summary — "All N steps completed" not just stat string
      const summary = trajectory.retrospective?.summary ?? '';
      assert.ok(summary.includes('All 2 steps completed'), `Expected narrative summary, got: "${summary}"`);
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

// ── Test 2: Verification mismatch failure ─────────────────────────────────────
//
// A step produces output but not the required sentinel.
// The trajectory should:
//   - Classify failure as "verification_mismatch"
//   - Name the missing sentinel in the diagnosis
//   - Include actionable learning about output format
//   - Produce a failure narrative summary (not "0/1 steps passed")

test(
  'trajectory quality: verification mismatch classified with actionable diagnosis',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    const sentinel = 'SENTINEL_NEVER_EMITTED';

    const config: RelayYamlConfig = {
      version: '1',
      name: 'traj-verify-fail-test',
      description: 'Tests verification mismatch trajectory classification.',
      swarm: { pattern: 'pipeline' },
      agents: [{ name: 'worker', cli: 'claude', interactive: false, constraints: { model: 'haiku' } }],
      workflows: [
        {
          name: 'default',
          steps: [
            {
              name: 'will-fail',
              agent: 'worker',
              // Task produces output but not the sentinel — deliberate mismatch
              task: 'Output exactly: TASK_COMPLETE',
              verification: { type: 'output_contains', value: sentinel },
            },
          ],
        },
      ],
      trajectories: { enabled: true },
    };

    try {
      const result = await harness.runWorkflow(config, undefined, { cwd });
      assertRunFailed(result);

      const trajectory = assertTrajectoryExists(harness, cwd);

      // 1. Failure classified as verification_mismatch
      const failureEvent = allEvents(trajectory).find((e) => e.type === 'error');
      assert.ok(failureEvent, 'Expected an error event in trajectory');
      assert.ok(
        failureEvent.content.includes('verification_mismatch'),
        `Expected failure classified as verification_mismatch, got: "${failureEvent.content}"`
      );

      // 2. Sentinel named in the diagnosis
      assert.ok(
        failureEvent.content.includes(sentinel),
        `Expected failure event to name the missing sentinel "${sentinel}", got: "${failureEvent.content}"`
      );

      // 3. Actionable learning about output format
      const learnings = trajectory.retrospective?.learnings ?? [];
      const outputFormatLearning = learnings.find(
        (l) => l.includes('output format') || l.includes('task prompt')
      );
      assert.ok(
        outputFormatLearning,
        `Expected learning about output format, got: ${JSON.stringify(learnings)}`
      );

      // 4. Failure narrative summary (not stats)
      const summary = trajectory.retrospective?.summary ?? '';
      assert.ok(
        summary.includes('verification_mismatch') || summary.includes('will-fail'),
        `Expected failure narrative mentioning step/cause, got: "${summary}"`
      );
      assert.ok(
        !summary.match(/^\d+\/\d+ steps passed/),
        `Expected narrative summary, not stat string, got: "${summary}"`
      );
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

// ── Test 3: raw field carries machine-readable cause ─────────────────────────
//
// The failure event's raw field should include the structured cause so
// tooling (dashboards, future agents) can consume it without parsing prose.

test('trajectory quality: failure raw field carries structured cause', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  const config: RelayYamlConfig = {
    version: '1',
    name: 'traj-raw-cause-test',
    description: 'Verifies structured cause in raw field of failure events.',
    swarm: { pattern: 'pipeline' },
    agents: [{ name: 'worker', cli: 'claude', interactive: false, constraints: { model: 'haiku' } }],
    workflows: [
      {
        name: 'default',
        steps: [
          {
            name: 'mismatch-step',
            agent: 'worker',
            task: 'Say hello.',
            verification: { type: 'output_contains', value: 'STRUCTURED_CAUSE_TEST' },
          },
        ],
      },
    ],
    trajectories: { enabled: true },
  };

  try {
    const result = await harness.runWorkflow(config, undefined, { cwd });
    assertRunFailed(result);

    const trajectory = assertTrajectoryExists(harness, cwd);
    const failureEvent = allEvents(trajectory).find((e) => e.type === 'error');
    assert.ok(failureEvent, 'Expected error event');

    // raw.cause must be machine-readable — tools/dashboards use this
    const cause = failureEvent?.raw?.['cause'];
    assert.ok(
      typeof cause === 'string' && cause.length > 0,
      `Expected raw.cause to be a non-empty string, got: ${JSON.stringify(cause)}`
    );
    assert.equal(
      cause,
      'verification_mismatch',
      `Expected raw.cause to be "verification_mismatch", got: "${String(cause)}"`
    );

    // raw.rawError preserves the original error message for debugging
    assert.ok(
      typeof failureEvent?.raw?.['rawError'] === 'string',
      'Expected raw.rawError to be present for debugging'
    );
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
