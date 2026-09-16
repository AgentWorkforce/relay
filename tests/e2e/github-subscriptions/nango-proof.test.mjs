import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  assert.equal(receipts[0].nangoOperationId, operation.id);
  assert.equal(receipts[0].nangoMessageId, message.id);
  assert.equal(receipts[0].nonceDigest, createHash('sha256').update(expected.nonce).digest('hex'));
  assert.equal(
    receipts[0].payloadSha256,
    createHash('sha256').update(JSON.stringify(message.request.body.payload)).digest('hex')
  );
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

test('receipt projection removes URL credentials and handles HTTP header casing', () => {
  const configured = {
    ...expected,
    destination: 'https://user:private-pass@example.com/nango?secret=private-query#private-fragment',
  };
  const row = structuredClone(message);
  row.request.url = configured.destination;
  row.request.headers = { 'X-GitHub-Delivery': 'guid', 'X-GitHub-Event': 'pull_request' };
  const receipts = nangoForwardReceipts(operation, [row], configured);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].destination, 'https://example.com/nango');
  assert.equal(receipts[0].githubEvent, 'pull_request');
  assert(!JSON.stringify(receipts).includes('private-'));
});

test('bounds independent history reads while exhausting every detail cursor in inventory order', async () => {
  const inventory = Array.from({ length: 9 }, (_, i) => ({ ...operation, id: `operation-${i}` }));
  let active = 0,
    peak = 0,
    calls = 0;
  const result = await captureNangoForwards(
    async (name, args) => {
      if (name === 'logs_list_operations')
        return { operations: [...inventory, inventory[0]], pagination: { cursor: null } };
      active++;
      peak = Math.max(peak, active);
      calls++;
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const op = inventory.find((row) => row.id === args.operationId);
      return {
        operation: op,
        messages: args.messages.cursor ? [{ ...message, id: op.id + '-message' }] : [],
        pagination: { cursor: args.messages.cursor ? null : 'detail-next' },
      };
    },
    expected,
    {}
  );
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(calls, 18);
  assert.equal(result.inspectedOperations, 9);
  assert.equal(result.exhausted, true);
  assert.deepEqual(
    result.receipts.map((row) => row.nangoOperationId),
    inventory.map((row) => row.id)
  );
});

test('a failed history settles concurrent reads and cannot produce partial successful evidence', async () => {
  let completed = 0;
  await assert.rejects(
    captureNangoForwards(
      async (name, args) => {
        if (name === 'logs_list_operations')
          return {
            operations: [0, 1, 2, 3].map((i) => ({ ...operation, id: String(i) })),
            pagination: { cursor: null },
          };
        if (args.operationId === '0') throw new Error('history unavailable');
        await new Promise((resolve) => setImmediate(resolve));
        completed++;
        return {
          operation: { ...operation, id: args.operationId },
          messages: [message],
          pagination: { cursor: null },
        };
      },
      expected,
      {}
    ),
    /Nango operation histories failed \(1\/4\): 0/
  );
  assert.equal(completed, 3);
});

test('malformed success envelopes and tool content never expose upstream bytes', async () => {
  for (const text of [
    '<html>PRIVATE_UPSTREAM_SECRET</html>',
    '{"PRIVATE_UPSTREAM_SECRET":',
    'event: message\ndata: {"PRIVATE_UPSTREAM_SECRET":',
    JSON.stringify({ result: { content: [{ type: 'text', text: '{"PRIVATE_UPSTREAM_SECRET":' }] } }),
  ]) {
    await assert.rejects(
      nangoLogsCall('logs_list_operations', {}, 'test-key', async () => new Response(text)),
      (error) => {
        assert.equal(error.constructor, Error);
        assert.match(error.message, /^Nango log response contains invalid JSON/);
        assert(!error.stack.includes('PRIVATE_UPSTREAM_SECRET'));
        assert.equal(error.cause, undefined);
        return true;
      }
    );
  }
  const data = { operations: [], pagination: { cursor: null } };
  for (const result of [
    { structuredContent: data },
    { content: [{ type: 'text', text: JSON.stringify(data) }] },
  ]) {
    for (const body of [
      JSON.stringify({ result }),
      `event: message\ndata: ${JSON.stringify({ result })}\n\n`,
    ])
      assert.deepEqual(
        await nangoLogsCall('logs_list_operations', {}, 'test-key', async () => new Response(body)),
        data
      );
  }
});

test('all failed operation identities survive batch settlement without raw rejection content', async () => {
  let completed = 0;
  await assert.rejects(
    captureNangoForwards(
      async (name, args) => {
        if (name === 'logs_list_operations')
          return {
            operations: [0, 1, 2, 3].map((i) => ({ ...operation, id: `op-${i}` })),
            pagination: { cursor: null },
          };
        await new Promise((resolve) => setImmediate(resolve));
        completed++;
        if (['op-0', 'op-2'].includes(args.operationId)) throw new Error('PRIVATE_UPSTREAM_SECRET');
        return {
          operation: { ...operation, id: args.operationId },
          messages: [],
          pagination: { cursor: null },
        };
      },
      expected,
      {}
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.match(error.message, /\(2\/4\): op-0, op-2/);
      assert.deepEqual(
        error.errors.map((e) => e.operationId),
        ['op-0', 'op-2']
      );
      assert(![error, ...error.errors].some((e) => e.stack.includes('PRIVATE_UPSTREAM_SECRET') || e.cause));
      return true;
    }
  );
  assert.equal(completed, 4);
});

test('invalid envelope/result/content shapes produce only bounded diagnostics', async () => {
  for (const result of [
    null,
    [],
    'PRIVATE_UPSTREAM_SECRET',
    { content: {} },
    { content: 'PRIVATE_UPSTREAM_SECRET' },
    { content: [null, { type: 'text', text: { secret: 'PRIVATE_UPSTREAM_SECRET' } }] },
    { structuredContent: [] },
  ]) {
    await assert.rejects(
      nangoLogsCall(
        'logs_list_operations',
        {},
        'test-key',
        async () => new Response(JSON.stringify({ result }))
      ),
      (error) => {
        assert.equal(error.constructor, Error);
        assert(!error.stack.includes('PRIVATE_UPSTREAM_SECRET'));
        assert.equal(error.cause, undefined);
        return true;
      }
    );
  }
});

test('invalid operation IDs cannot enter requests or failure diagnostics', async () => {
  for (const id of [null, {}, '', 'private\nbody', 'x'.repeat(129)]) {
    let details = 0;
    await assert.rejects(
      captureNangoForwards(
        async (name) => {
          if (name === 'logs_list_operations')
            return { operations: [{ ...operation, id }], pagination: { cursor: null } };
          details++;
        },
        expected,
        {}
      ),
      /^Error: Invalid Nango operation identity$/
    );
    assert.equal(details, 0);
  }
});
