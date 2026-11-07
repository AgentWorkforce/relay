import { expect, it } from 'vitest';
import { toRelayNode } from '../packages/sdk/src/messaging/relaycast-translate.js';

it('omits activeAgents for offline nodes and preserves live zero', () => {
  const offline = toRelayNode({ status: 'offline', live: false, active_agents: 0 });
  expect(offline.activeAgents).toBeUndefined();
  const live = toRelayNode({ status: 'online', live: true, active_agents: 0 });
  expect(live.activeAgents).toBe(0);
});
