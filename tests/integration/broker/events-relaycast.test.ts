/**
 * Workflow event ordering and Relaycast channel integration tests.
 *
 * Tests that WorkflowRunner emits events in the correct order and that
 * Relaycast channels receive workflow messages when configured.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/events-relaycast.test.js
 */
import test, { type TestContext } from 'node:test';

import type { RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { checkPrerequisites } from './utils/broker-harness.js';
import { WorkflowRunnerHarness } from './utils/workflow-harness.js';
import { assertRunCompleted, assertWorkflowEventOrder } from './utils/workflow-assert-helpers.js';

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
    name: 'test-events',
    swarm: { pattern: 'dag' },
    agents: [{ name: 'worker', cli: 'claude' }],
    workflows: [
      {
        name: 'default',
        steps: [{ name: 'step-1', agent: 'worker', task: 'Do a thing' }],
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

test('events: onEvent fires in correct order', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(makeConfig());
    assertRunCompleted(result);
    assertWorkflowEventOrder(result.events, [
      'run:started',
      'step:started',
      'step:completed',
      'run:completed',
    ]);
  } finally {
    await harness.stop();
  }
});

test('events: relaycast channel receives workflow messages', { timeout: 120_000 }, async (t) => {
  if (skipIfMissing(t)) return;

  if (!process.env.RELAY_API_KEY) {
    t.skip('RELAY_API_KEY not set — skipping Relaycast channel test');
    return;
  }

  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(
      makeConfig({
        swarm: { pattern: 'dag', channel: 'test-obs' },
      })
    );
    assertRunCompleted(result);
  } finally {
    await harness.stop();
  }
});
