import test from 'node:test';
import assert from 'node:assert/strict';

import { assertExpectedHeadSha } from './report-status.mjs';

const CURRENT = 'a'.repeat(40);

test('manual proof dispatch accepts the exact current PR head', () => {
  assert.doesNotThrow(() => assertExpectedHeadSha(CURRENT, CURRENT));
});

test('manual proof dispatch refuses a stale or malformed expected head before publishing status', () => {
  assert.throws(
    () => assertExpectedHeadSha('b'.repeat(40), CURRENT),
    /PR head changed before proof dispatch/
  );
  assert.throws(() => assertExpectedHeadSha('not-a-sha', CURRENT), /Expected PR proof head SHA/);
});
