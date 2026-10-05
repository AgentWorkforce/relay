import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEphemeralWorkspaceName,
  buildHarnessChildEnv,
  isRetryableWorkspaceRegistrationError,
  spawnHarnessClientWithRetry,
} from './utils/broker-harness.js';
import type { HarnessDriverClient } from '@agent-relay/harness-driver';

test('ephemeral workspace names stay unique across parallel test processes', () => {
  const first = buildEphemeralWorkspaceName(1_700_000_000_000, 101, 'alpha');
  const secondProcess = buildEphemeralWorkspaceName(1_700_000_000_000, 202, 'alpha');
  const secondAttempt = buildEphemeralWorkspaceName(1_700_000_000_000, 101, 'bravo');

  assert.notEqual(first, secondProcess);
  assert.notEqual(first, secondAttempt);
});

test('broker harness copies only allowlisted variables from the caller', () => {
  const child: NodeJS.ProcessEnv = buildHarnessChildEnv({
    PATH: '/safe/bin',
    HOME: '/safe/home',
    LANG: 'C.UTF-8',
    AGENT_RELAY_MCP_COMMAND: '/safe/agent-relay mcp',
    AGENT_RELAY_INSTALL_DIR: '/safe/agent-relay',
    AGENT_RELAY_BIN_DIR: '/safe/bin',
    UNRELATED_PARENT_SECRET: 'must-not-cross',
  });

  assert.equal(child.UNRELATED_PARENT_SECRET, undefined);
  assert.deepEqual(child, {
    PATH: '/safe/bin',
    HOME: '/safe/home',
    LANG: 'C.UTF-8',
    AGENT_RELAY_MCP_COMMAND: '/safe/agent-relay mcp',
    AGENT_RELAY_INSTALL_DIR: '/safe/agent-relay',
    AGENT_RELAY_BIN_DIR: '/safe/bin',
  });
});

for (const name of [
  'RELAY_NODE_ID',
  'RELAY_NODE_TOKEN',
  'AGENT_RELAY_ENROLLED_NODE_ID',
  'RELAY_WORKSPACE_KEY',
  'AGENT_RELAY_WORKSPACE_KEY',
  'RELAY_API_KEY',
]) {
  test(`broker harness refuses a caller carrying ${name}`, () => {
    assert.throws(() => buildHarnessChildEnv({ [name]: 'poisoned' }), new RegExp(name));
  });
}

test('broker harness ignores blank caller credential declarations', () => {
  assert.deepEqual(
    buildHarnessChildEnv({
      PATH: '/safe/bin',
      RELAY_NODE_ID: '  ',
      RELAY_NODE_TOKEN: '',
      AGENT_RELAY_ENROLLED_NODE_ID: '\t',
      RELAY_WORKSPACE_KEY: '',
      AGENT_RELAY_WORKSPACE_KEY: ' ',
      RELAY_API_KEY: '\n',
    }),
    { PATH: '/safe/bin' }
  );
});

test('broker harness retries only transient workspace registration failures', async () => {
  const transient = new Error(
    'failed registering agent with AGENT_RELAY_WORKSPACE_KEY workspace key: status: 500; code: internal_error'
  );
  const expectedClient = {} as HarnessDriverClient;
  let attempts = 0;
  const delays: number[] = [];

  const client = await spawnHarnessClientWithRetry(
    {},
    async () => {
      attempts += 1;
      if (attempts < 3) throw transient;
      return expectedClient;
    },
    async (delayMs) => {
      delays.push(delayMs);
    }
  );

  assert.equal(client, expectedClient);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
});

test('broker harness does not retry unrelated startup failures', async () => {
  let attempts = 0;
  const failure = new Error('broker binary is missing');

  await assert.rejects(
    spawnHarnessClientWithRetry(
      {},
      async () => {
        attempts += 1;
        throw failure;
      },
      async () => assert.fail('unrelated failure must not be delayed or retried')
    ),
    failure
  );

  assert.equal(attempts, 1);
  assert.equal(isRetryableWorkspaceRegistrationError(failure), false);
});

test('broker harness bounds transient workspace registration retries', async () => {
  let attempts = 0;
  const transient = new Error(
    'failed registering agent with AGENT_RELAY_WORKSPACE_KEY workspace key: code: internal_error'
  );

  await assert.rejects(
    spawnHarnessClientWithRetry(
      {},
      async () => {
        attempts += 1;
        throw transient;
      },
      async () => {}
    ),
    transient
  );

  assert.equal(attempts, 3);
});
