import assert from 'node:assert/strict';

// These are distinct product failure classes, not merely unsuccessful actions.
const expectedFailures = {
  'fleet-invalid-cwd': /worker_cwd is not (?:resolvable|a directory)/,
  'fleet-unavailable-command': /failed to spawn worker[\s\S]*No such file or directory/,
  'fleet-immediate-exit':
    /process exited during startup \(exit status: 1\)|failed writing frame to worker|spawn_harness_not_ready/,
  'fleet-delayed-exit': /spawn_harness_not_ready/,
  'fleet-membership-failure': /reserved_channel_name/,
};

export function assertFleetStartupFailure(name, result) {
  assert(expectedFailures[name], `Unknown startup fixture: ${name}`);
  assert.equal(result?.status, 'failed', `${name}: action did not fail`);
  assert.equal(typeof result.error, 'string', `${name}: missing terminal error`);
  assert(!/agent_name_in_use/.test(result.error), `${name}: exhausted name-in-use retries`);
  assert.match(result.error, expectedFailures[name], `${name}: wrong startup failure class`);
}

/** Only admission collisions are retried; none counts as a passing fixture. */
export async function observeFleetStartupFailure(name, attempt, onRetry) {
  for (let retry = 0; ; retry++) {
    const result = await attempt(retry);
    if (result?.status === 'failed' && /agent_name_in_use/.test(result.error ?? '') && retry < 6) {
      await onRetry(retry + 1);
      continue;
    }
    assertFleetStartupFailure(name, result);
    return result;
  }
}
