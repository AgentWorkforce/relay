import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEphemeralWorkspaceName,
  buildHarnessChildEnv,
  spawnHarnessClientOnce,
} from './utils/broker-harness.js';

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

test('broker harness never replays an ambiguous registration failure', async () => {
  const ambiguous = new Error('registration returned an ambiguous server failure');
  let attempts = 0;

  await assert.rejects(
    spawnHarnessClientOnce({}, async () => {
      attempts += 1;
      throw ambiguous;
    }),
    ambiguous
  );

  assert.equal(attempts, 1);
});
