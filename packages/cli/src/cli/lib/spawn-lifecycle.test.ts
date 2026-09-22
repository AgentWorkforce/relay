import { describe, expect, it } from 'vitest';
import { sanitizedSpawnReceipt, spawnLifecycleState } from './spawn-lifecycle.js';

describe('spawn lifecycle readiness modes', () => {
  it.each([true, false])('requires a readiness boolean in mode %s', (verifyReady) => {
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: true } }, verifyReady)).toBe(
      'failed'
    );
    expect(spawnLifecycleState({ status: 'completed', output: { ready: true } }, verifyReady)).toBe('failed');
  });
  it.each([true, false])('reports an unverified launch as accepted with ready=%s', (ready) => {
    expect(spawnLifecycleState({ status: 'completed', output: { spawned: true, ready } }, false)).toBe(
      'accepted'
    );
  });
  it('keeps readiness mandatory by default for MCP', () => {
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
