import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nangoForwardReceipts, captureNangoForwards, nangoLogsCall } from './nango-proof.mjs';
const expected = {
  destination: 'https://example.com/nango',
  connectionId: 'connection',
  providerConfigKey: 'github-relay',
  repo: 'owner/repo',
  nonce: 'a'.repeat(32),
};
const operation = {
  id: 'operation',
  operation: { type: 'webhook', action: 'forward' },
  integrationName: 'github-relay',
  environmentName: 'production',
};
const message = {
  id: 'message',
  createdAt: '2026-09-11T12:00:00Z',
  request: {
    url: expected.destination,
    method: 'POST',
    headers: {
      'x-github-delivery': 'guid',
      'x-github-event': 'pull_request',
      'x-hub-signature': 'private-signature',
    },
    body: {
      connectionId: expected.connectionId,
      providerConfigKey: expected.providerConfigKey,
      payload: {
        repository: { full_name: expected.repo },
        body: `GHSUB_EVENT_NONCE=${expected.nonce} private-title`,
        action: 'closed',
      },
    },
  },
  response: { code: 202 },
};
test('matches real forwarded request body when the operation omits connection identity and redacts content', () => {
  const receipts = nangoForwardReceipts(operation, [message], expected);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].githubDeliveryId, 'guid');
  const encoded = JSON.stringify(receipts);
  for (const secret of ['private-signature', 'private-title', expected.nonce])
    assert(!encoded.includes(secret));
  assert.deepEqual(nangoForwardReceipts(operation, [message], { ...expected, connectionId: 'other' }), []);
  assert.deepEqual(
    nangoForwardReceipts(operation, [message], { ...expected, destination: 'https://bypass.example' }),
    []
  );
});
test('exhausts empty operation pages and detail pages with cursors without a connection filter', async () => {
  let ops = 0,
    details = 0;
  const result = await captureNangoForwards(
    async (name, args) => {
      if (name === 'logs_list_operations') {
        assert.equal(args.connections, undefined);
        return ++ops === 1
          ? { operations: [], pagination: { cursor: 'next' } }
          : { operations: [operation], pagination: { cursor: null } };
      }
      return {
        operation,
        messages: ++details === 1 ? [message] : [],
        pagination: { cursor: details === 1 ? 'detail-next' : null },
      };
    },
    expected,
    { from: '2026-09-11T12:00:00Z' }
  );
  assert.equal(result.receipts.length, 1);
  assert.equal(result.exhausted, true);
  assert.equal(ops, 2);
  assert.equal(details, 2);
});
test('rejects stalled pagination and non-log calls', async () => {
  await assert.rejects(
    captureNangoForwards(async () => ({ operations: [], pagination: { cursor: 'stuck' } }), expected, {}),
    /Incomplete/
  );
  await assert.rejects(nangoLogsCall('connections_delete', {}, 'key'), /read-only/);
});
