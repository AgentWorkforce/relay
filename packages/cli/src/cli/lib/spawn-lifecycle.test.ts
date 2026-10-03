import { describe, expect, it } from 'vitest';
import { sanitizedSpawnReceipt, spawnLifecycleState } from './spawn-lifecycle.js';

describe('spawn lifecycle readiness', () => {
  it('keeps a terminal success without launch and readiness proof unconfirmed', () => {
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: true } })).toBe(
      'unconfirmed_may_be_running'
    );
    expect(spawnLifecycleState({ status: 'completed', output: { ready: true } })).toBe(
      'unconfirmed_may_be_running'
    );
    expect(spawnLifecycleState({ status: 'completed' })).toBe('unconfirmed_may_be_running');
  });

  it('keeps ready:false unconfirmed but treats explicit spawned:false as failed', () => {
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: true, ready: false } })).toBe(
      'unconfirmed_may_be_running'
    );
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: false, ready: true } })).toBe(
      'failed'
    );
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: true, ready: true } })).toBe(
      'ready'
    );
  });

  it('preserves ready:false in sanitized receipts', () => {
    expect(
      sanitizedSpawnReceipt({
        status: 'completed',
        output: { spawned: true, ready: false, secret: 'hidden' },
      })
    ).toEqual({ status: 'completed', output: { spawned: true, ready: false } });
  });
});
