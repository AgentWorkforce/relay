import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHarnessChildEnv, rejectUnsafeHarnessEnvironment } from './utils/broker-harness.js';

test('broker harness copies only allowlisted variables from the caller', () => {
  const child: NodeJS.ProcessEnv = buildHarnessChildEnv({
    PATH: '/safe/bin',
    HOME: '/safe/home',
    LANG: 'C.UTF-8',
    UNRELATED_PARENT_SECRET: 'must-not-cross',
  });

  assert.equal(child.UNRELATED_PARENT_SECRET, undefined);
  assert.deepEqual(child, {
    PATH: '/safe/bin',
    HOME: '/safe/home',
    LANG: 'C.UTF-8',
  });
});

for (const name of [
  'RELAY_NODE_ID',
  'RELAY_NODE_TOKEN',
  'AGENT_RELAY_ENROLLED_NODE_ID',
  'RELAY_WORKSPACE_KEY',
]) {
  test(`broker harness refuses a caller carrying ${name}`, () => {
    assert.throws(() => rejectUnsafeHarnessEnvironment({ [name]: 'poisoned' }), new RegExp(name));
  });
}
