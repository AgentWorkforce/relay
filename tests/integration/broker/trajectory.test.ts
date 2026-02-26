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

test('trajectory: file written during run', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);

    const trajectory = harness.getTrajectory(cwd);
    assertTrajectoryExists(harness, cwd);
    // Verify the trajectory is non-null with required fields
    if (!trajectory) {
      throw new Error('Expected trajectory file to be written');
    }
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
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);

    const trajectory = assertTrajectoryExists(harness, cwd);
    assertTrajectoryCompleted(trajectory);

    // Verify the trajectory file exists in completed/ directory
    const completedDir = path.join(cwd, '.trajectories', 'completed');
    const files = fs.existsSync(completedDir) ? fs.readdirSync(completedDir) : [];
    if (files.length === 0) {
      throw new Error(`Expected trajectory file in ${completedDir}`);
    }
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
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    assertRunCompleted(result);

    const trajectory = assertTrajectoryExists(harness, cwd);
    assertTrajectoryHasChapters(trajectory, 1);
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
    const result = await harness.runWorkflow(makeConfig(agentName), undefined, { cwd });
    assertRunCompleted(result);

    const trajectory = assertTrajectoryExists(harness, cwd);
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
