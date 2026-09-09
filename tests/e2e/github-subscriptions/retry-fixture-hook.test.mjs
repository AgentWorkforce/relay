import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryFailedFixtureHook } from './retry-fixture-hook.mjs';
const at = '2026-09-09T00:00:00Z';
const stimulus = { repo: 'acme/demo', pr: 7, commentId: 42 };
const failure = {
  ...stimulus,
  at,
  deliveryId: 'owned-guid',
  error: 'GitHub Relayfile envelope admission failed (429)',
};
const failedDelivery = { id: 99, guid: 'owned-guid', delivered_at: at, status_code: 502 };
function setup(extra = {}) {
  const calls = [];
  return {
    calls,
    args: {
      stimulus,
      failure,
      hooks: [{ repo: 'acme/demo', id: 12 }],
      attempts: [],
      now: Date.parse(at) + 30_000,
      gh: async (...args) => {
        calls.push(args);
        return args[1] === 'POST' ? null : [failedDelivery];
      },
      ...extra,
    },
  };
}
test('redelivers the failed original through GitHub after backoff and records the attempt', async () => {
  const { calls, args } = setup();
  const result = await retryFailedFixtureHook(args);
  assert.equal(result.guid, 'owned-guid');
  assert.equal(args.attempts.length, 1);
  assert.deepEqual(calls[1], ['repos/acme/demo/hooks/12/deliveries/99/attempts', 'POST']);
  assert.equal(await retryFailedFixtureHook(args), null);
  assert.equal(calls.length, 2);
});
for (const [name, extra] of [
  ['wrong repo', { failure: { ...failure, repo: 'acme/other' } }],
  ['wrong comment', { failure: { ...failure, commentId: 43 } }],
  ['wrong fixture', { failure: { ...failure, pr: 8 } }],
  ['unowned hook', { hooks: [] }],
  ['permanent error', { failure: { ...failure, error: 'GitHub Relayfile envelope admission failed (401)' } }],
  ['backoff', { now: Date.parse(at) + 29_999 }],
  ['exhausted', { attempts: Array.from({ length: 3 }, () => ({ ...stimulus, at })) }],
])
  test(`does not retry ${name}`, async () => {
    const { calls, args } = setup(extra);
    assert.equal(await retryFailedFixtureHook(args), null);
    assert.equal(calls.length, 0);
  });
test('does not retry another delivery or a success newer than the recorded failure', async () => {
  for (const deliveries of [
    [{ ...failedDelivery, guid: 'foreign' }],
    [failedDelivery, { ...failedDelivery, id: 100, delivered_at: '2026-09-09T00:00:10Z', status_code: 202 }],
  ]) {
    const { calls, args } = setup();
    args.gh = async (...a) => {
      calls.push(a);
      return deliveries;
    };
    assert.equal(await retryFailedFixtureHook(args), null);
    assert.equal(calls.length, 1);
  }
});
test('retains an ambiguous request attempt and surfaces its failure', async () => {
  const { args } = setup();
  args.gh = async (_endpoint, method) => {
    if (method) throw Error('request timeout');
    return [failedDelivery];
  };
  await assert.rejects(retryFailedFixtureHook(args), /request timeout/);
  assert.equal(args.attempts.length, 1);
});

test('invalid delivery list fails loudly without requesting redelivery', async () => {
  const { args } = setup();
  args.gh = async () => null;
  await assert.rejects(retryFailedFixtureHook(args), /Invalid GitHub delivery list/);
  assert.equal(args.attempts.length, 0);
});
