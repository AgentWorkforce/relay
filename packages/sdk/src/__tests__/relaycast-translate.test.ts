import { describe, expect, it } from 'vitest';

import { normalizeWebhookSubscription, toRelayNode } from '../messaging/relaycast-translate.js';

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

describe('subscription event normalization', () => {
  it.each([
    { events: ['message.created', 'thread.reply'] },
    { event_types: ['message.created', 'thread.reply'] },
    { eventTypes: ['message.created', 'thread.reply'] },
  ])('normalizes plural events: %j', (raw) => {
    expect(normalizeWebhookSubscription({ id: 'sub', ...raw }).events).toEqual([
      'message.created',
      'thread.reply',
    ]);
  });

  it('falls back to a singular event only when plural events are absent', () => {
    expect(normalizeWebhookSubscription({ event: 'thread.reply' }).events).toEqual(['thread.reply']);
    expect(normalizeWebhookSubscription({ events: [], event: 'thread.reply' }).events).toEqual([]);
    expect(normalizeWebhookSubscription({}).events).toBeUndefined();
  });
});
