/**
 * Workflow event ordering and Relaycast channel integration tests.
 *
 * Tests that WorkflowRunner emits workflow events in the expected order and
 * that Relaycast channels receive workflow lifecycle messages when configured.
 *
 * Run:
 *   npx tsc -p tests/integration/broker/tsconfig.json
 *   node --test tests/integration/broker/dist/events-relaycast.test.js
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { RelayCast } from '@agent-relay/sdk';
import type { RelayYamlConfig } from '@agent-relay/sdk/workflows';
import { checkPrerequisites, ensureApiKey } from './utils/broker-harness.js';
import { WorkflowRunnerHarness } from './utils/workflow-harness.js';
import { assertRunCompleted, assertWorkflowEventOrder } from './utils/workflow-assert-helpers.js';
import { sleep } from './utils/cli-helpers.js';

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

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const channel = `events-relay-${suffix}`;
  const workflowName = `workflow-${suffix}`;

  const harness = new WorkflowRunnerHarness();
  await harness.start();

  try {
    const result = await harness.runWorkflow(
      makeConfig({
        name: workflowName,
        swarm: { pattern: 'dag', channel },
        workflows: [
          {
            name: workflowName,
            steps: [{ name: 'step-1', agent: 'worker', task: 'Do a thing' }],
          },
        ],
      })
    );
    assertRunCompleted(result);

    const apiKey = await ensureApiKey();
    const api = new RelayCast({ apiKey });

    let messages: Array<{ id: string; agent_name: string; text: string; created_at: string }> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      messages = (await api.messages.list(channel, { limit: 50 })) as any;
      if (messages.length > 0) break;
      await sleep(1_000);
    }

    assert.ok(
      messages.some((message) => message.text.includes(`Workflow **${workflowName}**`)),
      `expected workflow messages for "${workflowName}" in channel "${channel}"`
    );
  } finally {
    await harness.stop();
  }
});
