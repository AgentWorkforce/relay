import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import failureSummary, { redactFailureMessage } from './failure-summary-reporter.mjs';

test('failure summary redacts Relay credential material', () => {
  const prefixes = [
    ['rk', 'live'].join('_') + '_',
    ['rjt', 'live'].join('_') + '_',
    ['at', 'live'].join('_') + '_',
    ['nt', 'live'].join('_') + '_',
    ['ot', 'live'].join('_') + '_',
    ['cld', 'at'].join('_') + '_',
    ['rth', 'at'].join('_') + '_',
    ['ocl', 'node', 'enr'].join('_') + '_',
    ['arr', 'live'].join('_') + '_',
    'br_',
  ];

  for (const prefix of prefixes) {
    const syntheticCredential = `${prefix}SYNTHETIC_NOT_A_SECRET`;
    const message = redactFailureMessage(`request failed for x${syntheticCredential}`);

    assert.equal(message, 'request failed for x[REDACTED_RELAY_CREDENTIAL]');
    assert.ok(!message.includes(syntheticCredential));
  }
});

test('failure summary emits only the redacted one-line error', async () => {
  const syntheticAgentToken = ['at', 'live', 'SYNTHETIC_NOT_A_SECRET'].join('_');
  async function* events() {
    yield {
      type: 'test:fail',
      data: {
        name: 'synthetic failure',
        details: { error: { message: `Bearer ${syntheticAgentToken}\nsecond line` } },
      },
    };
  }

  let output = '';
  for await (const chunk of failureSummary(events())) output += chunk;

  assert.match(output, /FAIL synthetic failure: Bearer \[REDACTED_RELAY_CREDENTIAL\] second line/);
  assert.ok(!output.includes(syntheticAgentToken));
});

test('failure summary bounds long startup diagnostics', async () => {
  async function* events() {
    yield {
      type: 'test:fail',
      data: {
        name: 'bounded failure',
        details: { error: { message: 'x'.repeat(500) } },
      },
    };
  }

  let output = '';
  for await (const chunk of failureSummary(events())) output += chunk;

  assert.ok(output.length < 260);
  assert.match(output, /…$/m);
});

test('broker cleanroom scenario retains TAP skip fail-closed output', async () => {
  const matrixUrl = new URL('../../relayflows/cleanroom/relay.matrix.json', import.meta.url);
  const matrix = JSON.parse(await readFile(matrixUrl, 'utf8'));
  const scenario = matrix.lanes
    .flatMap((lane) => lane.scenarios ?? [])
    .find((candidate) => candidate.id === 'broker-process-integration');

  assert.ok(scenario, 'broker-process-integration scenario must exist');
  assert.ok(scenario.command.includes('--test-reporter=tap'));
  assert.ok(scenario.command.includes('tests/integration/broker/failure-summary-reporter.test.mjs'));
  assert.ok(scenario.forbidOutput.includes('# SKIP'));
});
