import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTaskSubmissionObserver } from './task-observation.mjs';

describe('Claude task-submission proof observation', () => {
  it('reassembles a marker and gap split across worker-stream frames', () => {
    const observer = createTaskSubmissionObserver();

    assert.equal(observer.observe({ type: 'worker_stream', payload: { chunk: '\r\nTASK_STAR' } }), undefined);
    assert.equal(observer.observe({ type: 'worker_stream', payload: { chunk: 'TED gap_' } }), undefined);
    assert.deepEqual(observer.observe({ type: 'worker_stream', payload: { chunk: 'ms=251\r\n' } }), {
      marker: 'TASK_STARTED',
      gapMs: 251,
      output: '\r\nTASK_STARTED gap_ms=251\r\n',
    });
  });

  it('ignores unrelated frames while retaining partial worker output', () => {
    const observer = createTaskSubmissionObserver();

    assert.equal(
      observer.observe({ type: 'worker_stream', payload: { chunk: 'TASK_PARKED gap_' } }),
      undefined
    );
    assert.equal(observer.observe({ type: 'delivery_injected', payload: {} }), undefined);
    assert.deepEqual(observer.observe({ type: 'worker_stream', payload: { chunk: 'ms=2' } }), {
      marker: 'TASK_PARKED',
      gapMs: 2,
      output: 'TASK_PARKED gap_ms=2',
    });
  });
});
