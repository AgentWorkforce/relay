import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyProbeOutput, runCapturedProcess } from './probe-diagnostics.mjs';

test('diagnostic classification never returns captured URLs or credentials', () => {
  const secretBearing = 'wss://127.0.0.1:1234/fs/ws?token=opaque-secret';
  const classification = classifyProbeOutput(secretBearing);
  assert.equal(classification, 'other_output');
  assert.doesNotMatch(classification, /opaque-secret|wss?:\/\//);
});

test('captured process waits for drained output and returns bounded metadata only', async () => {
  const script = "setTimeout(() => { process.stderr.write('context deadline exceeded\\n'); process.exit(1); }, 20)";
  const result = await runCapturedProcess(process.execPath, ['-e', script]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.diagnostic, 'deadline_exceeded');
  assert.ok(result.outputBytes > 0);
  assert.equal(result.outputTruncated, false);
  assert.deepEqual(Object.keys(result).sort(), ['diagnostic', 'exitCode', 'outputBytes', 'outputTruncated', 'signal']);
});

test('captured process bounds arbitrary output without persisting it', async () => {
  const result = await runCapturedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(20000))"]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.diagnostic, 'other_output');
  assert.equal(result.outputBytes, 20000);
  assert.equal(result.outputTruncated, true);
  assert.equal('output' in result, false);
});
