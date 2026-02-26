import assert from 'node:assert/strict';

import type { BrokerEvent } from '@agent-relay/sdk';
import type { DryRunReport, WorkflowEvent } from '@agent-relay/sdk/workflows';
import type { TrajectoryFile, WorkflowRunResult, WorkflowRunnerHarness } from './workflow-harness.js';

function getStepEvent(result: WorkflowRunResult, type: string, stepName: string): WorkflowEvent | undefined {
  return result.events.find(
    (event) => event.type === type && 'stepName' in event && event.stepName === stepName
  );
}

export function assertRunCompleted(result: WorkflowRunResult): void {
  assert.equal(result.run.status, 'completed', `Expected run to be completed, got "${result.run.status}"`);
}

export function assertRunFailed(result: WorkflowRunResult, errorSubstring?: string): void {
  assert.equal(result.run.status, 'failed', `Expected run to be failed, got "${result.run.status}"`);

  const runFailed = result.events.find((event) => event.type === 'run:failed');
  assert.ok(runFailed, 'Expected run:failed event');

  if (errorSubstring) {
    const error = result.run.error ?? ('error' in runFailed ? runFailed.error : undefined);
    assert.ok(
      typeof error === 'string' && error.includes(errorSubstring),
      `Expected failure to contain "${errorSubstring}", got: ${String(error)}`
    );
  }
}

export function assertStepCompleted(result: WorkflowRunResult, stepName: string): void {
  const event = getStepEvent(result, 'step:completed', stepName);
  assert.ok(event, `Expected "${stepName}" to complete`);
}

export function assertStepFailed(result: WorkflowRunResult, stepName: string): void {
  const event = getStepEvent(result, 'step:failed', stepName);
  assert.ok(event, `Expected "${stepName}" to fail`);
}

export function assertStepSkipped(result: WorkflowRunResult, stepName: string): void {
  const event = getStepEvent(result, 'step:skipped', stepName);
  assert.ok(event, `Expected "${stepName}" to be skipped`);
}

export function assertStepOrder(result: WorkflowRunResult, stepNames: string[]): void {
  let cursor = -1;
  for (const stepName of stepNames) {
    const index = result.events.findIndex(
      (event, i) =>
        i > cursor && event.type === 'step:started' && 'stepName' in event && event.stepName === stepName
    );
    assert.ok(index !== -1, `Expected step "${stepName}" to start`);
    cursor = index;
  }
}

export function assertStepsParallel(result: WorkflowRunResult, stepNames: string[]): void {
  const startIndexes: Record<string, number> = {};
  const completedIndexes: Record<string, number> = {};

  for (const name of stepNames) {
    const startIndex = result.events.findIndex(
      (event, i) => i >= 0 && event.type === 'step:started' && 'stepName' in event && event.stepName === name
    );
    const completedIndex = result.events.findIndex(
      (event, i) =>
        i >= 0 && event.type === 'step:completed' && 'stepName' in event && event.stepName === name
    );
    assert.ok(startIndex !== -1, `Expected "${name}" to start`);
    assert.ok(completedIndex !== -1, `Expected "${name}" to complete`);
    startIndexes[name] = startIndex;
    completedIndexes[name] = completedIndex;
  }

  for (let i = 1; i < stepNames.length; i += 1) {
    const priorName = stepNames[i - 1];
    const currentName = stepNames[i];
    assert.ok(
      startIndexes[currentName] < completedIndexes[priorName],
      `Expected "${currentName}" to start before "${priorName}" completed`
    );
  }
}

export function assertWorkflowEventOrder(
  events: WorkflowEvent[],
  expectedTypes: WorkflowEvent['type'][]
): void {
  let cursor = -1;
  for (const expected of expectedTypes) {
    const index = events.findIndex((event, i) => i > cursor && event.type === expected);
    assert.ok(index !== -1, `Expected event "${expected}" to appear in order`);
    cursor = index;
  }
}

export function assertStepOutput(
  result: WorkflowRunResult,
  stepName: string,
  expectedSubstring: string
): void {
  const event = result.events.find(
    (candidate) =>
      candidate.type === 'step:completed' &&
      'stepName' in candidate &&
      candidate.stepName === stepName &&
      'output' in candidate &&
      typeof candidate.output === 'string'
  ) as (WorkflowEvent & { output: string }) | undefined;

  assert.ok(event, `Expected "${stepName}" to have output`);
  assert.ok(
    event.output.includes(expectedSubstring),
    `Expected output of "${stepName}" to include "${expectedSubstring}"`
  );
}

export function assertStepCount(
  result: WorkflowRunResult,
  status: 'completed' | 'failed' | 'skipped',
  expectedCount: number
): void {
  const eventType = `step:${status}` as const;
  const count = result.events.filter((event) => event.type === eventType).length;
  assert.equal(count, expectedCount, `Expected ${expectedCount} ${status} steps, got ${count}`);
}

export function assertTrajectoryExists(harness: WorkflowRunnerHarness, cwd: string): TrajectoryFile {
  const trajectory = harness.getTrajectory(cwd);
  assert.ok(trajectory, `Expected a trajectory file under "${cwd}/.trajectories"`);

  assert.ok(typeof trajectory.id === 'string' && trajectory.id.length > 0, 'Expected trajectory.id');
  assert.equal(typeof trajectory.version, 'number', 'Expected trajectory.version to be a number');
  assert.ok(
    trajectory.status === 'active' || trajectory.status === 'completed' || trajectory.status === 'abandoned',
    `Unexpected trajectory status "${trajectory.status}"`
  );
  assert.equal(typeof trajectory.startedAt, 'string', 'Expected trajectory.startedAt');
  assert.ok(
    typeof trajectory.task?.title === 'string' && trajectory.task.title.length > 0,
    'Expected trajectory.task.title'
  );
  assert.ok(Array.isArray(trajectory.chapters), 'Expected trajectory.chapters to be an array');

  return trajectory;
}

export function assertTrajectoryCompleted(trajectory: TrajectoryFile): void {
  assert.equal(
    trajectory.status,
    'completed',
    `Expected trajectory to be completed, got "${trajectory.status}"`
  );
}

export function assertTrajectoryHasChapters(trajectory: TrajectoryFile, minCount: number): void {
  assert.ok(Number.isInteger(minCount) && minCount >= 0, `Invalid minCount "${minCount}"`);
  assert.ok(
    trajectory.chapters.length >= minCount,
    `Expected at least ${minCount} trajectory chapters, got ${trajectory.chapters.length}`
  );
}

export function assertBrokerEventEmitted<K extends BrokerEvent['kind']>(
  brokerEvents: BrokerEvent[],
  kind: K,
  predicate?: (event: Extract<BrokerEvent, { kind: K }>) => boolean
): Extract<BrokerEvent, { kind: K }> {
  const matches = brokerEvents.filter(
    (event): event is Extract<BrokerEvent, { kind: K }> => event.kind === kind
  );
  assert.ok(matches.length > 0, `Expected broker event kind "${kind}" to be emitted`);

  if (!predicate) {
    return matches[0];
  }

  const matched = matches.find((event) => predicate(event));
  assert.ok(matched, `Expected broker event kind "${kind}" to match predicate`);
  return matched;
}

export function assertStepRetried(
  result: WorkflowRunResult,
  stepName: string,
  minAttempts: number
): Extract<WorkflowEvent, { type: 'step:retrying' }> {
  assert.ok(Number.isInteger(minAttempts) && minAttempts >= 1, `Invalid minAttempts "${minAttempts}"`);

  const retryEvents = result.events.filter(
    (event): event is Extract<WorkflowEvent, { type: 'step:retrying' }> =>
      event.type === 'step:retrying' && event.stepName === stepName
  );
  assert.ok(retryEvents.length > 0, `Expected "${stepName}" to emit step:retrying`);

  const maxAttempt = retryEvents.reduce((max, event) => Math.max(max, event.attempt), 0);
  assert.ok(
    maxAttempt >= minAttempts,
    `Expected "${stepName}" to retry at least ${minAttempts} times, got ${maxAttempt}`
  );

  const matchingEvent = retryEvents.find((event) => event.attempt >= minAttempts);
  assert.ok(matchingEvent, `Expected "${stepName}" retry event with attempt >= ${minAttempts}`);
  return matchingEvent;
}

export function assertDryRunValid(report: DryRunReport): void {
  assert.equal(report.valid, true, 'Expected dry-run report to be valid');
  assert.equal(
    report.errors.length,
    0,
    `Expected dry-run report to have no errors, got: ${JSON.stringify(report.errors)}`
  );
}
