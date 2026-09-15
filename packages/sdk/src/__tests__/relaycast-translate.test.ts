import { describe, expect, it } from 'vitest';

import { toRelayNode } from '../messaging/relaycast-translate.js';

describe('toRelayNode fleet liveness', () => {
  it('omits stale active-agent load for an offline node', () => {
    const node = toRelayNode({ status: 'offline', live: false, active_agents: 0 });
    expect(node.activeAgents).toBeUndefined();
  });

  it('preserves measured zero for a live node', () => {
    const node = toRelayNode({ status: 'online', live: true, active_agents: 0 });
    expect(node.activeAgents).toBe(0);
  });
});
