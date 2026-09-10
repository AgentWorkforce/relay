import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCommandOutputRedactors, run } from './run-cloud.mjs';

describe('cloud command output redaction', () => {
  it('keeps partial credential suffixes on their originating stream', () => {
    const redactors = createCommandOutputRedactors();

    assert.equal(redactors.stdout.push('stdout: rk_live_', false), 'stdout: ');
    assert.equal(redactors.stderr.push('stderr: unrelated', false), 'stderr: unrelated');
    assert.equal(redactors.stdout.push('secret-value', true), 'rk_live_…');
  });

  it('does not redact or drop a benign trailing prefix fragment at stream end', () => {
    const redactors = createCommandOutputRedactors();

    assert.equal(redactors.stdout.push('finished with br', false), 'finished with ');
    assert.equal(redactors.stdout.push('', true), 'br');
  });

  it('masks configured secrets split across streams before echo and capture', async () => {
    const result = await run(
      process.execPath,
      ['-e', "process.stdout.write('custom-'); process.stderr.write('secret-value')"],
      { diagnosticSecretValues: ['custom-secret-value'] }
    );

    assert.equal(result.stdout, '[redacted]');
    assert.equal(result.stderr, '[redacted]');
    assert.doesNotMatch(result.stdout, /custom-/);
    assert.doesNotMatch(result.stderr, /secret-value/);
  });
});
