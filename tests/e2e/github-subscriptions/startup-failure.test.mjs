import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { awaitBrokerClose } from './startup-failure.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertFleetStartupFailure, observeFleetStartupFailure } from './startup-failure.mjs';
const cases = {
  'fleet-invalid-cwd': 'spawn_failed: worker_cwd is not resolvable: /owned/missing',
  'fleet-unavailable-command': 'spawn_failed: failed to spawn worker: No such file or directory (os error 2)',
  'fleet-immediate-exit': "spawn_failed: agent 'fixture' process exited during startup (exit status: 1)",
  'fleet-delayed-exit': 'spawn_harness_not_ready',
  'fleet-membership-failure': 'reserved_channel_name',
};
for (const [name, error] of Object.entries(cases)) {
  test(`${name}: exhausted admission retries cannot certify intended failure`, async () => {
    let attempts = 0,
      retries = 0;
    await assert.rejects(
      observeFleetStartupFailure(
        name,
        async () => {
          attempts++;
          return { status: 'failed', error: 'agent_name_in_use' };
        },
        async () => {
          retries++;
        }
      ),
      /exhausted name-in-use retries/
    );
    assert.equal(attempts, 7);
    assert.equal(retries, 6);
  });
  test(`${name}: retry only collisions then require the intended class`, async () => {
    let attempts = 0;
    const result = await observeFleetStartupFailure(
      name,
      async () => ({
        status: 'failed',
        error: attempts++ < 2 ? 'agent_name_in_use' : error,
      }),
      async () => {}
    );
    assert.equal(attempts, 3);
    assert.equal(result.error, error);
    for (const result of [
      { status: 'completed', error },
      { status: 'pending' },
      { status: 'failed', error: 'unrelated failure' },
    ])
      assert.throws(() => assertFleetStartupFailure(name, result));
    assert.throws(() =>
      assertFleetStartupFailure(name, { status: 'failed', error: `agent_name_in_use: ${error}` })
    );
  });
}

test('broker close waits are bounded and preserve the real child exit tuple', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(7), 200)'], {
    env: {},
    stdio: 'ignore',
  });
  const close = once(child, 'close');
  await assert.rejects(awaitBrokerClose(close, 10), /close was not observed/);
  assert.deepEqual(await awaitBrokerClose(close, 5000), [7, null]);
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});
