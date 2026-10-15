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

  assert.match(output, /FAIL synthetic failure/);
  assert.match(output, /DETAIL synthetic failure: Bearer \[REDACTED_RELAY_CREDENTIAL\] second line/);
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

  assert.ok(Buffer.byteLength(output, 'utf8') <= 900);
  assert.match(output, /…$/m);
});

test('failure summary caps aggregate output and counts omissions', async () => {
  async function* events() {
    for (let index = 0; index < 20; index += 1) {
      yield {
        type: 'test:fail',
        data: {
          name: `failure-${index}-${'n'.repeat(180)}`,
          details: { error: { message: 'm'.repeat(500) } },
        },
      };
    }
  }

  let output = '';
  for await (const chunk of failureSummary(events())) output += chunk;

  assert.ok(Buffer.byteLength(output, 'utf8') <= 900);
  assert.match(output, /OMITTED_FAILURES count=\d+/);
  assert.match(output, /OMITTED_DETAILS count=\d+/);
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

test('messaging cleanroom scenario retains bounded failure reporting', async () => {
  const matrixUrl = new URL('../../relayflows/cleanroom/relay.matrix.json', import.meta.url);
  const matrix = JSON.parse(await readFile(matrixUrl, 'utf8'));
  const scenario = matrix.lanes
    .flatMap((lane) => lane.scenarios ?? [])
    .find((candidate) => candidate.id === 'messaging-mcp-process-roundtrip');

  assert.ok(scenario, 'messaging-mcp-process-roundtrip scenario must exist');
  assert.ok(scenario.command.includes('--test-reporter=tap'));
  assert.ok(
    scenario.command.includes('--test-reporter=./tests/integration/broker/failure-summary-reporter.mjs')
  );
  assert.ok(scenario.forbidOutput.includes('# SKIP'));
});

test('failure summary retains correlation and stderr beyond long startup command prefixes', async () => {
  const credential = 'Bearer synthetic-secret';
  async function* events() {
    yield {
      type: 'test:fail',
      data: {
        name: 'startup',
        details: {
          error: {
            message: `[broker_diag operation=startup origin=https://relay.example operation_elapsed_ms=42] Broker exited (cwd=${'x'.repeat(600)}; stderr_tail=registration (500): internal_error; request_id: request-abc; ${credential})`,
          },
        },
      },
    };
  }
  let output = '';
  for await (const chunk of failureSummary(events())) output += chunk;
  assert.match(output, /origin=https:\/\/relay\.example/);
  assert.match(output, /operation_elapsed_ms=42/);
  assert.match(output, /request_id=request-abc/);
  assert.match(output, /stderr_tail=registration \(500\): internal_error/);
  assert.ok(!output.includes('synthetic-secret'));
  assert.ok(Buffer.byteLength(output, 'utf8') <= 900);
});

test('failure summary redacts URL userinfo, query secrets and generic credential assignments', () => {
  const output = redactFailureMessage(
    'https://someone:password-value@relay.example/v1/agents?api_key=query-value#fragment-value api_key=key-value token: token-value authorization=header-value'
  );
  for (const secret of [
    'someone',
    'password-value',
    'query-value',
    'fragment-value',
    'key-value',
    'token-value',
    'header-value',
  ]) {
    assert.ok(!output.includes(secret));
  }
  assert.match(output, /https:\/\/relay\.example\/v1\/agents\?redacted/);
});
