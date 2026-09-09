import { describe, expect, it } from 'vitest';

import { toRelayNode } from '../messaging/relaycast-translate.js';

describe('toRelayNode fleet liveness', () => {
  it('does not present an unreachable node active-agent count as zero', () => {
    const node = toRelayNode({
      name: 'finn-mini',
      status: 'offline',
      live: false,
      active_agents: 0,
      capabilities: [],
    });

    expect(node.activeAgents).toBeUndefined();
  });

  it('preserves a measured zero for a reachable node', () => {
    const node = toRelayNode({
      name: 'finn-mini',
      status: 'online',
      live: true,
      active_agents: 0,
      capabilities: [],
    });

    expect(node.activeAgents).toBe(0);
  });
});
