/**
 * WorkflowRunner pattern and run behavior integration tests.
 *
 * Tests cover: fan-out diamond, DAG with verification, pipeline sequential,
 * hub-spoke fan, review-loop, error handling (fail-fast and continue),
 * builder API, and maxConcurrency configuration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { workflow, type RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness, type WorkflowRunResult } from './utils/workflow-harness.js';
import {
  assertRunCompleted,
  assertStepCompleted,
  assertStepOrder,
  assertStepsParallel,
  assertRunFailed,
  assertStepFailed,
  assertStepSkipped,
  assertStepOutput,
  assertStepCount,
} from './utils/workflow-assert-helpers.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    name: 'test-workflow-patterns',
    description: 'Integration test',
    swarm: { pattern: 'fan-out' },
    agents: [
      { name: 'coordinator', cli: 'claude', interactive: false },
      { name: 'worker-a', cli: 'claude', interactive: false },
      { name: 'worker-b', cli: 'claude', interactive: false },
    ],
    workflows: [
      {
        name: 'default',
        steps: [
          { name: 'step-a', agent: 'coordinator', task: 'Start' },
          { name: 'step-b', agent: 'worker-a', task: 'Branch A', dependsOn: ['step-a'] },
          { name: 'step-c', agent: 'worker-b', task: 'Branch B', dependsOn: ['step-a'] },
          { name: 'step-d', agent: 'coordinator', task: 'Merge', dependsOn: ['step-b', 'step-c'] },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'relay-wf-patterns-'));
}

function skipIfRateLimited(t: TestContext, result: WorkflowRunResult): boolean {
  const errors = [
    result.run.error ?? '',
    ...result.events
      .filter((event): event is typeof event & { error: string } => {
        return 'error' in event && typeof event.error === 'string';
      })
      .map((event) => event.error),
  ];
  const rateLimitError = errors.find((error) => /rate limit exceeded|too many requests|429/iu.test(error));
  if (!rateLimitError) return false;
  t.skip(`Relaycast API rate limit in test environment: ${rateLimitError}`);
  return true;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('workflow-patterns: fan-out pattern executes diamond workflow', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig(), undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepCompleted(result, 'step-c');
    assertStepCompleted(result, 'step-d');
    assertStepOrder(result, ['step-a', 'step-b', 'step-d']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: dag pattern with verification gate', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const config = makeConfig({
      name: 'test-dag-verification',
      swarm: { pattern: 'dag' },
      agents: [
        { name: 'coordinator', cli: 'claude', interactive: false },
        { name: 'worker-a', cli: 'claude', interactive: false },
        { name: 'worker-b', cli: 'claude', interactive: false },
      ],
      workflows: [
        {
          name: 'default',
          steps: [
            { name: 'init', agent: 'coordinator', task: 'Initialize the workflow' },
            { name: 'analyze', agent: 'worker-a', task: 'Analyze data', dependsOn: ['init'] },
            { name: 'transform', agent: 'worker-b', task: 'Transform data', dependsOn: ['init'] },
            {
              name: 'verify',
              type: 'deterministic',
              command: 'echo VERIFIED',
              dependsOn: ['analyze', 'transform'],
              verification: { type: 'output_contains', value: 'VERIFIED' },
            },
            { name: 'report', agent: 'coordinator', task: 'Generate report', dependsOn: ['verify'] },
          ],
        },
      ],
    });

    const result = await harness.runWorkflow(config, undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'init');
    assertStepCompleted(result, 'analyze');
    assertStepCompleted(result, 'transform');
    assertStepCompleted(result, 'verify');
    assertStepCompleted(result, 'report');
    assertStepOrder(result, ['init', 'analyze', 'verify', 'report']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: pipeline pattern executes sequentially', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const config = makeConfig({
      name: 'test-pipeline-sequential',
      swarm: { pattern: 'pipeline' },
      agents: [
        { name: 'stage-1', cli: 'claude', interactive: false },
        { name: 'stage-2', cli: 'claude', interactive: false },
      ],
      workflows: [
        {
          name: 'default',
          steps: [
            { name: 'extract', agent: 'stage-1', task: 'Extract data from source' },
            { name: 'transform', agent: 'stage-2', task: 'Transform extracted data', dependsOn: ['extract'] },
            { name: 'load', agent: 'stage-1', task: 'Load transformed data', dependsOn: ['transform'] },
            { name: 'validate', agent: 'stage-2', task: 'Validate loaded data', dependsOn: ['load'] },
          ],
        },
      ],
    });

    const result = await harness.runWorkflow(config, undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'extract');
    assertStepCompleted(result, 'transform');
    assertStepCompleted(result, 'load');
    assertStepCompleted(result, 'validate');
    assertStepOrder(result, ['extract', 'transform', 'load', 'validate']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: hub-spoke pattern fans to workers', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const config = makeConfig({
      name: 'test-hub-spoke',
      swarm: { pattern: 'hub-spoke' },
      agents: [
        { name: 'hub', cli: 'claude', interactive: false },
        { name: 'spoke-a', cli: 'claude', interactive: false },
        { name: 'spoke-b', cli: 'claude', interactive: false },
        { name: 'spoke-c', cli: 'claude', interactive: false },
      ],
      workflows: [
        {
          name: 'default',
          steps: [
            { name: 'plan', agent: 'hub', task: 'Plan the work distribution' },
            { name: 'spoke-a', agent: 'spoke-a', task: 'Process partition A', dependsOn: ['plan'] },
            { name: 'spoke-b', agent: 'spoke-b', task: 'Process partition B', dependsOn: ['plan'] },
            { name: 'spoke-c', agent: 'spoke-c', task: 'Process partition C', dependsOn: ['plan'] },
            {
              name: 'collect',
              agent: 'hub',
              task: 'Collect and merge results',
              dependsOn: ['spoke-a', 'spoke-b', 'spoke-c'],
            },
          ],
        },
      ],
    });

    const result = await harness.runWorkflow(config, undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'plan');
    assertStepCompleted(result, 'spoke-a');
    assertStepCompleted(result, 'spoke-b');
    assertStepCompleted(result, 'spoke-c');
    assertStepCompleted(result, 'collect');
    assertStepOrder(result, ['plan', 'spoke-a', 'collect']);
    assertStepsParallel(result, ['spoke-a', 'spoke-b', 'spoke-c']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: review-loop pattern with verification', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const config = makeConfig({
      name: 'test-review-loop',
      swarm: { pattern: 'review-loop' },
      agents: [
        { name: 'author', cli: 'claude', interactive: false },
        { name: 'reviewer', cli: 'claude', interactive: false },
      ],
      workflows: [
        {
          name: 'default',
          steps: [
            { name: 'draft', agent: 'author', task: 'Write the initial draft' },
            {
              name: 'review',
              agent: 'reviewer',
              task: 'Review the draft and provide feedback',
              dependsOn: ['draft'],
            },
          ],
        },
      ],
    });

    const result = await harness.runWorkflow(config, undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'draft');
    assertStepCompleted(result, 'review');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: error handling fail-fast skips downstream', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const config = makeConfig({
      name: 'test-fail-fast',
      swarm: { pattern: 'dag' },
      errorHandling: { strategy: 'fail-fast' },
      agents: [
        { name: 'worker-a', cli: 'claude', interactive: false },
        { name: 'worker-b', cli: 'claude', interactive: false },
      ],
      workflows: [
        {
          name: 'default',
          steps: [
            { name: 'setup', agent: 'worker-a', task: 'Initialize environment' },
            {
              name: 'will-fail',
              agent: 'worker-a',
              task: 'This step will fail verification',
              dependsOn: ['setup'],
              verification: { type: 'output_contains', value: 'IMPOSSIBLE_STRING_NEVER_PRODUCED' },
            },
            {
              name: 'downstream',
              agent: 'worker-b',
              task: 'This should be skipped',
              dependsOn: ['will-fail'],
            },
          ],
        },
      ],
    });

    const result = await harness.runWorkflow(config, undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunFailed(result);
    assertStepFailed(result, 'will-fail');
    assertStepSkipped(result, 'downstream');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test(
  'workflow-patterns: error handling continue completes despite failure',
  { timeout: 120_000 },
  async (t) => {
    if (skipIfMissing(t)) return;

    const cwd = createWorkdir();
    const harness = new WorkflowRunnerHarness();
    await harness.start();

    try {
      const config = makeConfig({
        name: 'test-continue-on-error',
        swarm: { pattern: 'dag' },
        errorHandling: { strategy: 'continue' },
        agents: [
          { name: 'worker-a', cli: 'claude', interactive: false },
          { name: 'worker-b', cli: 'claude', interactive: false },
        ],
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'setup', agent: 'worker-a', task: 'Initialize environment' },
              {
                name: 'will-fail',
                agent: 'worker-a',
                task: 'This step will fail verification',
                dependsOn: ['setup'],
                verification: { type: 'output_contains', value: 'IMPOSSIBLE_STRING_NEVER_PRODUCED' },
              },
              {
                name: 'independent',
                agent: 'worker-b',
                task: 'This runs independently of will-fail',
                dependsOn: ['setup'],
              },
              {
                name: 'final',
                agent: 'worker-b',
                task: 'Final aggregation step',
                dependsOn: ['independent'],
              },
            ],
          },
        ],
      });

      const result = await harness.runWorkflow(config, undefined, { cwd });
      if (skipIfRateLimited(t, result)) return;
      assertRunCompleted(result);
      assertStepFailed(result, 'will-fail');
      assertStepCompleted(result, 'independent');
      assertStepCompleted(result, 'final');
    } finally {
      await harness.stop();
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  }
);

test('workflow-patterns: builder-generated config executes correctly', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const built = workflow('builder-pattern')
      .pattern('fan-out')
      .agent('coordinator', { cli: 'claude', interactive: false })
      .agent('worker-a', { cli: 'claude', interactive: false })
      .agent('worker-b', { cli: 'claude', interactive: false })
      .step('step-a', { agent: 'coordinator', task: 'Start fan-out' })
      .step('step-b', { agent: 'worker-a', task: 'Branch A', dependsOn: ['step-a'] })
      .step('step-c', { agent: 'worker-b', task: 'Branch B', dependsOn: ['step-a'] })
      .step('step-d', {
        agent: 'coordinator',
        task: 'Merge branches',
        dependsOn: ['step-b', 'step-c'],
      })
      .toConfig();

    const result = await harness.runWorkflow(built, undefined, { cwd });
    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-a');
    assertStepCompleted(result, 'step-b');
    assertStepCompleted(result, 'step-c');
    assertStepCompleted(result, 'step-d');
    assertStepOrder(result, ['step-a', 'step-b', 'step-d']);
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});

test('workflow-patterns: fan-out supports maxConcurrency config', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const cwd = createWorkdir();
  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(
      {
        ...makeConfig(),
        swarm: { pattern: 'fan-out', maxConcurrency: 2 },
        agents: [
          { name: 'coordinator', cli: 'claude', interactive: false },
          { name: 'worker-a', cli: 'claude', interactive: false },
          { name: 'worker-b', cli: 'claude', interactive: false },
          { name: 'worker-c', cli: 'claude', interactive: false },
        ],
        workflows: [
          {
            name: 'default',
            steps: [
              { name: 'step-a', agent: 'coordinator', task: 'Start' },
              { name: 'step-b', agent: 'worker-a', task: 'Branch A', dependsOn: ['step-a'] },
              { name: 'step-c', agent: 'worker-b', task: 'Branch B', dependsOn: ['step-a'] },
              { name: 'step-d', agent: 'worker-c', task: 'Branch C', dependsOn: ['step-a'] },
              {
                name: 'step-e',
                agent: 'coordinator',
                task: 'Done',
                dependsOn: ['step-b', 'step-c', 'step-d'],
              },
            ],
          },
        ],
      },
      undefined,
      { cwd }
    );

    if (skipIfRateLimited(t, result)) return;
    assertRunCompleted(result);
    assertStepCompleted(result, 'step-e');
  } finally {
    await harness.stop();
    fs.rmSync(cwd, { force: true, recursive: true });
  }
});
