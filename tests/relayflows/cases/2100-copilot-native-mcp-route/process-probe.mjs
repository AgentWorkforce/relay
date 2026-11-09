// Test-only process cleanup verification, never accepted routing evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { childEnv } from './guards.mjs';

/** Fail closed on query failure; a live-self canary distinguishes a broken ps from no match. */
export function processIsRunning(pid, { command = 'ps', env = childEnv(), timeoutMs = 2_000 } = {}) {
  assert(Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647, 'Invalid proof process id.');
  /** Return a validated process state or null only for a successful no-match query. */
  function stateOf(targetPid) {
    const result = spawnSync(command, ['-p', String(targetPid), '-o', 'stat='], {
      encoding: 'utf8',
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024,
    });
    assert(!result.error && !result.signal, 'Process-state query failed or was terminated.');
    assert.equal(result.stderr?.trim() ?? '', '', 'Process-state query reported an error.');
    const output = result.stdout?.trim() ?? '';
    if (result.status === 1) {
      assert.equal(output, '', 'Process-state no-match returned unexpected output.');
      return null;
    }
    assert.equal(result.status, 0, 'Process-state query returned an unexpected exit status.');
    assert(/^[RSDTtZXIWUPK][<NLSsl+WEXC-]*$/.test(output), 'Process-state query returned an invalid state.');
    return output;
  }
  const canary = stateOf(process.pid);
  assert(canary && !/^[ZX]/.test(canary), 'Process-state live-self canary failed.');
  const state = pid === process.pid ? canary : stateOf(pid);
  return state !== null && !/^[ZX]/.test(state);
}
