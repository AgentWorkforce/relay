/**
 * Workflow trajectory file lifecycle integration tests.
 *
 * Tests that trajectory files are written during runs, transition to
 * completed/, have chapters recorded, and capture agent names correctly.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/trajectory.test.js
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
  assertTrajectoryExists,
  assertTrajectoryCompleted,
  assertTrajectoryHasChapters,
} from './utils/workflow-assert-helpers.js';

function skipIfMissing(t: TestContext): boolean {
  const reason = checkPrerequisites();
  if (reason) {
    t.skip(reason);
    return true;
  }
  return false;
}

function makeConfig(agentName = 'worker'): RelayYamlConfig {
  return {
    version: '1',
    name: 'test-trajectory',
    swarm: { pattern: 'dag' },
    agents: [{ name: agentName, cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [{ name: 'step-1', agent: agentName, task: 'Do a thing' }],
      },
    ],
    trajectories: { enabled: true },
  };
}

function createWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-traj-'));
}

async function runWorkflowAndGetTrajectory(
  harness: WorkflowRunnerHarness,
  config: ReturnType<typeof makeConfig>,
  cwd: string
) {
  const result = await harness.runWorkflow(config, undefined, { cwd });
  assertRunCompleted(result);

  return assertTrajectoryExists(harness, cwd);
}

test('trajectory: file written during run', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const trajectory = await runWorkflowAndGetTrajectory(harness, makeConfig(), cwd);
    assert.ok(trajectory.id.length > 0, 'Expected trajectory file to include an id');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('trajectory: file transitions to completed status after run', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const trajectory = await runWorkflowAndGetTrajectory(harness, makeConfig(), cwd);
    assertTrajectoryCompleted(trajectory);

    const activePath = path.join(cwd, '.trajectories', 'active', `${trajectory.id}.json`);
    const completedPath = path.join(cwd, '.trajectories', 'completed', `${trajectory.id}.json`);

    assert.equal(
      fs.existsSync(activePath),
      false,
      'Expected active trajectory file to be removed after completion'
    );
    assert.equal(
      fs.existsSync(completedPath),
      true,
      `Expected completed trajectory file at "${completedPath}"`
    );
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('trajectory: chapters are recorded during workflow execution', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const trajectory = await runWorkflowAndGetTrajectory(harness, makeConfig(), cwd);
    assertTrajectoryHasChapters(trajectory, 1);

    for (const chapter of trajectory.chapters) {
      assert.equal(typeof chapter.id, 'string', 'Expected chapter.id to be a string');
      assert.equal(typeof chapter.title, 'string', 'Expected chapter.title to be a string');
      assert.equal(typeof chapter.startedAt, 'string', 'Expected chapter.startedAt to be a string');
      assert.equal(typeof chapter.agentName, 'string', 'Expected chapter.agentName to be a string');
      assert.ok(Array.isArray(chapter.events), 'Expected chapter.events to be an array');
    }
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('trajectory: chapters record agent names', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const agentName = 'my-worker';
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const trajectory = await runWorkflowAndGetTrajectory(harness, makeConfig(agentName), cwd);
    assertTrajectoryHasChapters(trajectory, 1);

    const agentNamesInChapters = trajectory.chapters.map((ch) => ch.agentName);
    if (!agentNamesInChapters.some((name) => name === agentName)) {
      throw new Error(
        `Expected at least one chapter with agentName "${agentName}", got: ${JSON.stringify(agentNamesInChapters)}`
      );
    }
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
