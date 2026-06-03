import { describe, expect, it, vi } from 'vitest';

import { RelaycastMessagingClient } from '../messaging/index.js';

function createRelaycastMock() {
  return {
    agents: {
      list: vi.fn(),
      get: vi.fn(),
      register: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      presence: vi.fn(),
    },
    channels: { list: vi.fn(), get: vi.fn() },
    messages: { list: vi.fn(), get: vi.fn(), thread: vi.fn(), reactions: vi.fn() },
    webhooks: {
      create: vi.fn(),
      createInbound: vi.fn(async (d: { channel: string; name?: string }) => ({
        webhook_id: 'wh_1',
        name: d.name ?? 'inbound',
        channel: d.channel,
        url: 'https://relay.example/webhooks/wh_1',
        token: 'tok_abc',
        is_active: true,
        created_at: '2026-06-03T00:00:00Z',
      })),
      list: vi.fn(async () => [
        {
          webhook_id: 'wh_1',
          channel: 'deploy-status',
          url: 'https://relay.example/webhooks/wh_1',
          token: 'tok_abc',
          created_at: '2026-06-03T00:00:00Z',
        },
      ]),
      delete: vi.fn(async () => undefined),
      trigger: vi.fn(async () => ({ ok: true })),
    },
    subscriptions: {
      create: vi.fn(async (d: unknown) => ({
        id: 'sub_1',
        is_active: true,
        created_at: '2026-06-03T00:00:00Z',
        ...(d as object),
      })),
      list: vi.fn(async () => [
        { id: 'sub_1', url: 'https://x', events: ['message.created'], created_at: '2026-06-03T00:00:00Z' },
      ]),
      get: vi.fn(async (id: string) => ({ id })),
      delete: vi.fn(async () => undefined),
    },
    actions: {
      register: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    },
    workspace: { info: vi.fn() },
  };
}

describe('relay.webhooks namespace', () => {
  it('createInbound strips a leading # and maps the snake_case response', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });

    const webhook = await client.webhooks.createInbound({ channel: '#deploy-status' });

    expect(relaycast.webhooks.createInbound).toHaveBeenCalledWith({ channel: 'deploy-status' });
    expect(webhook).toEqual({
      webhookId: 'wh_1',
      url: 'https://relay.example/webhooks/wh_1',
      token: 'tok_abc',
      channel: 'deploy-status',
      name: 'inbound',
      createdAt: '2026-06-03T00:00:00Z',
    });
  });

  it('createInbound forwards an optional name', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });

    await client.webhooks.createInbound({ channel: 'ops', name: 'CI bot' });
    expect(relaycast.webhooks.createInbound).toHaveBeenCalledWith({ channel: 'ops', name: 'CI bot' });
  });

  it('subscribe creates an outbound subscription with url/events/secret/headers', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });

    const sub = await client.webhooks.subscribe({
      url: 'https://example.com/hook',
      events: ['message.created', 'action.completed'],
      secret: 's',
      headers: { Authorization: 'Bearer x' },
    });

    expect(relaycast.subscriptions.create).toHaveBeenCalledWith({
      url: 'https://example.com/hook',
      events: ['message.created', 'action.completed'],
      secret: 's',
      headers: { Authorization: 'Bearer x' },
    });
    expect(sub.id).toBe('sub_1');
    expect(sub.events).toEqual(['message.created', 'action.completed']);
  });

  it('subscribe omits undefined optional fields', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });

    await client.webhooks.subscribe({ url: 'https://example.com/hook', events: ['message.created'] });
    expect(relaycast.subscriptions.create).toHaveBeenCalledWith({
      url: 'https://example.com/hook',
      events: ['message.created'],
    });
  });

  it('list/delete/subscriptions/unsubscribe delegate to the relaycast surface', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });

    const webhooks = await client.webhooks.list();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].webhookId).toBe('wh_1');

    await client.webhooks.delete('wh_1');
    expect(relaycast.webhooks.delete).toHaveBeenCalledWith('wh_1');

    const subs = await client.webhooks.subscriptions();
    expect(subs[0].id).toBe('sub_1');

    await client.webhooks.unsubscribe('sub_1');
    expect(relaycast.subscriptions.delete).toHaveBeenCalledWith('sub_1');
  });
});
