import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrokerHarness,
  buildEphemeralWorkspaceName,
  buildHarnessChildEnv,
  diagnoseBrokerOperation,
  spawnHarnessClientOnce,
  waitForNodeRegistration,
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

test('broker harness waits for read-only node visibility before spawning workers', async () => {
  let lookups = 0;
  const delays: number[] = [];

  await waitForNodeRegistration(
    'test-node',
    async () => {
      lookups += 1;
      if (lookups < 3) return null;
      return { name: 'test-node' };
    },
    async (delayMs) => {
      delays.push(delayMs);
    },
    3
  );

  assert.equal(lookups, 3);
  assert.deepEqual(delays, [500, 500]);
});

test('broker harness bounds node visibility checks', async () => {
  let lookups = 0;
  const missing = new Error('node_not_found');

  await assert.rejects(
    waitForNodeRegistration(
      'test-node',
      async () => {
        lookups += 1;
        throw missing;
      },
      async () => {},
      3
    ),
    (error: Error) =>
      error.message === "Broker node 'test-node' did not become visible after 3 read-only checks" &&
      error.cause === missing
  );

  assert.equal(lookups, 3);
});

test('broker failure context preserves cause without replay and strips URL credentials', async () => {
  const original = new Error('registration failed (500): internal_error; request_id: request-123');
  let calls = 0;
  await assert.rejects(
    diagnoseBrokerOperation(
      'spawn',
      {
        RELAYCAST_BASE_URL: 'https://user:synthetic-password@relay.example/path?api_key=synthetic-key',
        RELAY_BASE_URL: 'https://unused.example',
      },
      async () => {
        calls += 1;
        throw original;
      }
    ),
    (error: Error) => {
      assert.equal(error, original);
      assert.match(error.message, /operation=spawn origin=https:\/\/relay\.example operation_elapsed_ms=\d+/);
      assert.match(error.message, /request_id: request-123/);
      assert.doesNotMatch(error.message, /synthetic|unused|user:|\/path|api_key/);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('broker failure context reports hosted default and never prints malformed origin input', async () => {
  for (const [env, origin] of [
    [{}, 'https://cast.agentrelay.com'],
    [{ RELAY_BASE_URL: 'not-a-url-with-synthetic-secret' }, '<invalid-origin>'],
    [{ RELAYCAST_BASE_URL: ' ', RELAY_BASE_URL: 'https://unused.example' }, 'https://cast.agentrelay.com'],
  ] as const) {
    await assert.rejects(
      diagnoseBrokerOperation('startup', env, async () => {
        throw new Error('failed');
      }),
      (error: Error) => {
        assert.ok(error.message.includes(`origin=${origin}`));
        assert.doesNotMatch(error.message, /synthetic|unused/);
        return true;
      }
    );
  }
});

test('broker diagnostics preserve successful operations', async () => {
  const value = { registered: true };
  assert.equal(await diagnoseBrokerOperation('spawn', {}, async () => value), value);
});

test('spawn failures reach the harness diagnostic boundary without changing the request', async () => {
  const harness = new BrokerHarness({ binaryPath: '/unused-test-broker' });
  const original = Object.assign(
    new Error('registration failed (500): internal_error; request_id: request-wired'),
    { code: 'internal_error' }
  );
  const requests: unknown[] = [];
  harness.client = {
    spawnPty: async (request: unknown) => {
      requests.push(request);
      throw original;
    },
  } as unknown as typeof harness.client;
  await assert.rejects(harness.spawnAgent('fixture-agent'), (error: Error) => {
    assert.equal(error, original);
    assert.match(error.message, /broker_diag operation=spawn/);
    assert.match(error.message, /request_id: request-wired/);
    assert.equal((error as typeof original).code, 'internal_error');
    return true;
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    name: 'fixture-agent',
    cli: 'cat',
    channels: ['general'],
    task: undefined,
    continueFrom: undefined,
    model: undefined,
    exitAfterTask: undefined,
  });
});
