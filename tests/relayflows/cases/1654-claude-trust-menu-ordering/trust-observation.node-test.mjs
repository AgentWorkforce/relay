import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTrustDecision, TRUST_ACCEPTED, TRUST_EXITED } from './trust-observation.mjs';

test('parses an accepted decision', () => {
  const decision = parseTrustDecision('TRUST_ACCEPTED layout=modern\n');
  assert.equal(decision?.outcome, TRUST_ACCEPTED);
  assert.equal(decision?.layout, 'modern');
});

test('parses an exited decision', () => {
  assert.equal(parseTrustDecision('TRUST_EXITED layout=modern\n')?.outcome, TRUST_EXITED);
});

test('parses the legacy layout', () => {
  assert.equal(parseTrustDecision('TRUST_ACCEPTED layout=legacy')?.layout, 'legacy');
});

test('rejects a partially written file', () => {
  // A truncated read must never be mistaken for a decision — that would report
  // an outcome the broker never produced.
  assert.equal(parseTrustDecision('TRUST_ACC'), undefined);
  assert.equal(parseTrustDecision('TRUST_ACCEPTED layout='), undefined);
});

test('rejects unrelated content', () => {
  assert.equal(parseTrustDecision(''), undefined);
  assert.equal(parseTrustDecision('TRUST_PENDING layout=modern'), undefined);
  assert.equal(parseTrustDecision(undefined), undefined);
});
