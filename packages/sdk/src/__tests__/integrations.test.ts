import { describe, expect, it, vi } from 'vitest';

import { RelaycastMessagingClient } from '../messaging/index.js';

function createRelaycastMock() {
  return {
    agents: { list: vi.fn(), get: vi.fn(), register: vi.fn(), update: vi.fn(), delete: vi.fn(), presence: vi.fn() },
    channels: { list: vi.fn(), get: vi.fn() },
    messages: { list: vi.fn(), get: vi.fn(), thread: vi.fn(), reactions: vi.fn() },
    webhooks: {
      create: vi.fn(async (d: unknown) => ({ id: 'wh1', ...(d as object) })),
      list: vi.fn(async () => [{ id: 'wh1', url: 'https://x' }]),
      delete: vi.fn(async () => undefined),
      trigger: vi.fn(async () => ({ ok: true })),
    },
    subscriptions: {
      create: vi.fn(async (d: unknown) => ({ id: 'sub1', ...(d as object) })),
      list: vi.fn(async () => [{ id: 'sub1', event: 'message.created' }]),
      get: vi.fn(async (id: string) => ({ id })),
      delete: vi.fn(async () => undefined),
    },
    commands: {
      register: vi.fn(async (d: unknown) => ({ ...(d as object) })),
      list: vi.fn(async () => [{ command: 'deploy', description: 'Ship it', handlerAgent: 'ops' }]),
      delete: vi.fn(async () => undefined),
    },
    workspace: { info: vi.fn(async () => ({ id: 'ws1', name: 'Ops' })) },
  };
}

describe('SDK integrations / capabilities / workspace passthrough', () => {
  it('delegates webhook + subscription operations to relaycast', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });

    const webhook = await client.integrations.webhooks.create({ url: 'https://x', event: 'message.created' });
    expect(webhook.id).toBe('wh1');
    expect(relaycast.webhooks.create).toHaveBeenCalledWith({ url: 'https://x', event: 'message.created' });

    await client.integrations.webhooks.trigger('wh1', { hello: 'world' });
    expect(relaycast.webhooks.trigger).toHaveBeenCalledWith('wh1', { hello: 'world' });

    const subs = await client.integrations.subscriptions.list();
    expect(subs).toHaveLength(1);
  });

  it('delegates capability (command) operations to relaycast', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });

    const caps = await client.commands.list();
    expect(caps[0].command).toBe('deploy');

    await client.commands.register({ command: 'deploy', description: 'Ship it', handlerAgent: 'ops' });
    expect(relaycast.commands.register).toHaveBeenCalled();
  });

  it('exposes workspace.info()', async () => {
    const relaycast = createRelaycastMock();
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });
    const info = await client.workspace.info();
    expect(info.name).toBe('Ops');
  });

  it('throws a clear error when the relaycast surface is missing', async () => {
    const relaycast = createRelaycastMock();
    delete (relaycast as { webhooks?: unknown }).webhooks;
    const client = new RelaycastMessagingClient({ relaycast: relaycast as never });
    await expect(client.integrations.webhooks.list()).rejects.toThrow(/webhooks API/);
  });
});
