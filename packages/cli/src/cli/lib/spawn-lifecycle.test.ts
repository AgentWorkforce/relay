import { describe, expect, it } from 'vitest';
import { sanitizedSpawnReceipt, spawnLifecycleState, spawnPlacementReceipt } from './spawn-lifecycle.js';

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
