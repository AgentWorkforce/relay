import { describe, expect, it } from 'vitest';
import { sanitizedSpawnReceipt, spawnLifecycleState, spawnPlacementReceipt } from './spawn-lifecycle.js';

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

describe('spawn dispatch evidence', () => {
  // The engine's 201 for a placed spawn always names the chosen node in
  // handler_node_id, before it sends anything. When the send fails the row stays
  // pending with dispatched_node_id null; that is not a dispatch.
  it('does not treat the placed handler node as dispatch evidence', () => {
    expect(
      spawnPlacementReceipt({
        invocation_id: 'inv_unsent',
        status: 'pending',
        handler_node_id: 'node_sf_frame',
        dispatched_node_id: null,
      })
    ).toEqual({
      state: 'accepted',
      dispatchState: 'not_dispatched',
      invocationId: 'inv_unsent',
      handlerNodeId: 'node_sf_frame',
    });
  });

  it('reports dispatched once the engine records the dispatched node', () => {
    expect(
      spawnPlacementReceipt({
        invocation_id: 'inv_sent',
        status: 'pending',
        handler_node_id: 'node_sf_frame',
        dispatched_node_id: 'node_sf_frame',
      })
    ).toMatchObject({ dispatchState: 'dispatched', dispatchedNodeId: 'node_sf_frame' });
  });
});
