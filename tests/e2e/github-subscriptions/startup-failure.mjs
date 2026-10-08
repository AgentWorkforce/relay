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

export async function awaitBrokerClose(close, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      close,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned broker close was not observed')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function quoteCommandArgument(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

// Emit categories only. Arbitrary broker lines may contain credentials or URLs.
export function brokerDiagnostic(line) {
  for (const [needle, event] of [
    ['run_init begin', 'startup_begin'],
    ['API listener bound', 'api_listener_bound'],
    ['connect_relay completed', 'relay_connected'],
    ['process exited during startup', 'worker_startup_exit'],
    ['engine rejected a node control frame', 'node_control_rejection'],
    ['fleet node ws read failed', 'node_control_read_failed'],
    ['application acknowledgement deadline exceeded', 'node_control_ack_timeout'],
  ]) {
    if (line.includes(needle)) return { event };
  }
  return null;
}
