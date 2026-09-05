import assert from 'node:assert/strict';
import test from 'node:test';

import { createTrustObserver } from './trust-observation.mjs';

function streamFrame(chunk) {
  return { type: 'worker_stream', payload: { chunk } };
}

test('reports the accepted outcome and layout', () => {
  const observer = createTrustObserver();
  assert.equal(observer.observe(streamFrame('❯No,exit\r\n')), undefined);
  const observation = observer.observe(streamFrame('\r\nTRUST_ACCEPTED layout=modern\r\n'));
  assert.equal(observation?.outcome, 'ACCEPTED');
  assert.equal(observation?.layout, 'modern');
});

test('reports the exited outcome', () => {
  const observer = createTrustObserver();
  const observation = observer.observe(streamFrame('\r\nTRUST_EXITED layout=modern\r\n'));
  assert.equal(observation?.outcome, 'EXITED');
});

test('joins a marker split across PTY frames', () => {
  // PTY frames are transport chunks, so a marker can straddle two reads. A
  // per-frame regex would miss this and the proof would time out instead of
  // reporting the outcome it actually observed.
  const observer = createTrustObserver();
  assert.equal(observer.observe(streamFrame('\r\nTRUST_ACC')), undefined);
  const observation = observer.observe(streamFrame('EPTED layout=legacy\r\n'));
  assert.equal(observation?.outcome, 'ACCEPTED');
  assert.equal(observation?.layout, 'legacy');
});

test('ignores frames that are not worker output', () => {
  const observer = createTrustObserver();
  assert.equal(observer.observe({ type: 'worker_ready', payload: {} }), undefined);
  assert.equal(observer.observe({ type: 'worker_stream', payload: {} }), undefined);
});

test('does not match an unrelated marker', () => {
  const observer = createTrustObserver();
  assert.equal(observer.observe(streamFrame('TRUST_PENDING layout=modern\r\n')), undefined);
});
