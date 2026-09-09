import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  observeEnvelopeAdmissions,
  assertDuplicateAdmission,
  assertNoStalePrejoinAction,
} from './admission-proof.mjs';
const original = { deliveryId: 'guid', envelopeId: 'envelope', status: 202 };
const duplicate = { ...original, status: 409, errorCode: 'duplicate_envelope' };
test('requires completed duplicate admission, not a second queue acceptance', () => {
  for (const rows of [
    [original],
    [original, original],
    [original, { ...duplicate, envelopeId: 'other' }],
    [original, { ...duplicate, errorCode: 'other_conflict' }],
  ]) {
    assert.throws(() => assertDuplicateAdmission(rows, 'guid'), /same duplicate envelope/);
  }
  assert.deepEqual(assertDuplicateAdmission([original, duplicate], 'guid'), {
    envelopeId: 'envelope',
    status: 409,
    code: 'duplicate_envelope',
  });
});
test('observer leaves bytes and headers untouched and records only admission metadata', async () => {
  const init = {
    body: JSON.stringify({ envelopeId: 'envelope', deliveryId: 'guid', payload: 'private payload' }),
    headers: { 'X-Relay-Signature': 'private signature' },
  };
  const response = new Response(JSON.stringify({ code: 'duplicate_envelope', message: 'private response' }), {
    status: 409,
  });
  const rows = [];
  const wrapped = observeEnvelopeAdmissions(
    async (url, actual) => {
      assert.equal(url, 'https://example.test/envelopes');
      assert.equal(actual, init);
      return response;
    },
    'https://example.test/envelopes',
    (row) => rows.push(row)
  );
  assert.equal(await wrapped('https://example.test/envelopes', init), response);
  assert.match(await response.text(), /private response/);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['at', 'deliveryId', 'envelopeId', 'errorCode', 'status']);
  assert(!JSON.stringify(rows).includes('private'));
});
test('observer ignores other endpoints without consuming their response', async () => {
  const response = new Response('ordinary');
  const wrapped = observeEnvelopeAdmissions(
    async () => response,
    'https://example.test/envelopes',
    () => assert.fail()
  );
  assert.equal(await wrapped('https://example.test/other', {}), response);
  assert.equal(await response.text(), 'ordinary');
});
test('final stale check catches a prejoin action after the initial idle boundary', () => {
  assertNoStalePrejoinAction([{ agent_id: 'other', text: 'GHSUB_ACK old' }], 'actor', 'old');
  assert.throws(
    () =>
      assertNoStalePrejoinAction(
        [
          { agent_id: 'actor', text: 'GHSUB_ACK fresh' },
          { agent_id: 'actor', text: 'GHSUB_ACK old' },
        ],
        'actor',
        'old'
      ),
    /Stale prejoin/
  );
});
