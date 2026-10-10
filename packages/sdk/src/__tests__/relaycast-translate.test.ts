import { describe, expect, it } from 'vitest';

import { normalizeActionInvocation, toRelayNode } from '../messaging/relaycast-translate.js';

describe('toRelayNode fleet liveness', () => {
  it('omits stale active-agent load for an offline node', () => {
    const node = toRelayNode({ status: 'offline', live: false, active_agents: 0 });
    expect(node.activeAgents).toBeUndefined();
  });

  it('preserves measured zero for a live node', () => {
    const node = toRelayNode({ status: 'online', live: true, active_agents: 0 });
    expect(node.activeAgents).toBe(0);
  });

  it('omits active-agent load when liveness is unconfirmed', () => {
    const node = toRelayNode({ status: 'online', active_agents: 4 });
    expect(node.activeAgents).toBeUndefined();
  });
});

describe('normalizeActionInvocation dispatch evidence', () => {
  it('keeps the node that handled or was dispatched the invocation', () => {
    const invocation = normalizeActionInvocation({
      invocation_id: 'inv_late',
      action_name: 'spawn',
      status: 'failed',
      handler_node_id: 'node_a',
      dispatched_node_id: 'node_b',
    });
    expect(invocation).toMatchObject({ handlerNodeId: 'node_a', dispatchedNodeId: 'node_b' });
  });

  it('omits node ids the server did not report', () => {
    const invocation = normalizeActionInvocation({ invocation_id: 'inv', status: 'invoked' });
    expect(invocation).not.toHaveProperty('handlerNodeId');
    expect(invocation).not.toHaveProperty('dispatchedNodeId');
  });
});
