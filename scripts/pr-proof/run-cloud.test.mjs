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

  for (let boundary = 1; boundary < 'custom-secret-value'.length; boundary += 1) {
    it(`redacts a configured secret split at boundary ${boundary}`, () => {
      const secret = 'custom-secret-value';
      const redactors = createCommandOutputRedactors([secret], {
        maskPendingOnFinal: true,
      });

      assert.equal(redactors.stdout.push(secret.slice(0, boundary), false), '');
      const tail = redactors.stdout.push(secret.slice(boundary), true);
      assert.equal(tail, '[redacted]');
      assert.equal(redactors.stdout.requiresCapturedOutputMask(), false);
    });
  }

  for (const fragment of ['e', 'ue', 'lue']) {
    it(`does not wipe a stream for the benign ${fragment.length}-character secret fragment`, async () => {
      const output = `finished with ${fragment}`;
      const result = await run(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(output)})`], {
        diagnosticSecretValues: ['custom-secret-value'],
      });

      assert.equal(result.stdout, output);
    });
  }

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
