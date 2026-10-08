import { describe, expect, it } from 'vitest';
import { sanitizedSpawnReceipt, spawnLifecycleState } from './spawn-lifecycle.js';

describe('spawn lifecycle readiness', () => {
  it('rejects a terminal success without launch and readiness proof', () => {
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: true } })).toBe('failed');
    expect(spawnLifecycleState({ status: 'completed', output: { ready: true } })).toBe('failed');
  });

  // The broker's unverified success path declares `ready:false` rather than
  // omitting the field. This receipt is only derived for callers that required
  // readiness, so an honest "launched, not ready" is still not a ready spawn.
  it('treats a declared ready:false as a failed spawn for readiness callers', () => {
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: true, ready: false } })).toBe(
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
