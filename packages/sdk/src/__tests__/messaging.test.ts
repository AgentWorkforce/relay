import { describe, expect, it, vi } from 'vitest';

import {
  RelaycastMessagingClient,
  normalizeInbox,
  normalizeMessagingEvent,
  normalizeThread,
  type RelayMessagingEvent,
} from '../messaging/index.js';
import { ActionRegistry, AgentRelay } from '../index.js';

function createWorkspace() {
  return {
    agents: {
      list: vi.fn(async () => [
        {
          id: 'agent-1',
          name: 'WorkerA',
          type: 'agent',
          status: 'online',
          persona: 'builder',
          metadata: { role: 'worker' },
          last_seen: '2026-05-27T10:00:00.000Z',
          channels: [{ id: 'ch-1', name: '#general', role: 'member', joined_at: '2026-05-27T09:00:00.000Z' }],
        },
      ]),
      get: vi.fn(async () => ({ id: 'agent-1', name: 'WorkerA', type: 'agent', status: 'online' })),
      register: vi.fn(async () => ({
        id: 'agent-2',
        name: 'WorkerB',
        token: 'at_live_worker_b',
        status: 'offline',
        created_at: '2026-05-27T10:10:00.000Z',
      })),
      update: vi.fn(async (_name: string, input: unknown) => ({
        id: 'agent-1',
        name: 'WorkerA',
        type: 'agent',
        ...input,
      })),
      delete: vi.fn(async () => undefined),
      presence: vi.fn(async () => [{ agent_id: 'agent-1', agent_name: 'WorkerA', status: 'online' }]),
    },
    channels: {
      list: vi.fn(async () => [
        {
          id: 'ch-1',
          name: '#general',
          topic: 'Build room',
          created_by: 'System',
          created_at: '2026-05-27T08:00:00.000Z',
          is_archived: false,
          member_count: 2,
          members: [
            {
              agent_id: 'agent-1',
              agent_name: 'WorkerA',
              role: 'member',
              joined_at: '2026-05-27T09:00:00.000Z',
            },
          ],
        },
      ]),
      get: vi.fn(async () => ({ id: 'ch-1', name: 'general', topic: null, members: [] })),
    },
    messages: {
      list: vi.fn(async () => [
        {
          id: 'm-1',
          channel_id: 'ch-1',
          agent_id: 'agent-1',
          agent_name: 'WorkerA',
          text: 'hello',
          thread_id: null,
          attachments: [],
          reactions: [{ emoji: '+1', count: 1, agents: ['Lead'] }],
          created_at: '2026-05-27T11:00:00.000Z',
          reply_count: 0,
          read_by_count: 1,
        },
      ]),
      get: vi.fn(async () => ({ id: 'm-1', agent_name: 'WorkerA', text: 'hello', attachments: [] })),
      thread: vi.fn(async () => ({
        parent: { id: 'm-1', channel_id: 'ch-1', agent_name: 'Lead', text: 'parent', attachments: [] },
        replies: [
          {
            id: 'm-2',
            agent_name: 'WorkerA',
            text: 'reply',
            attachments: [],
            created_at: '2026-05-27T11:05:00.000Z',
          },
        ],
      })),
      reactions: vi.fn(async () => [{ emoji: 'eyes', count: 2, agents: ['Lead', 'WorkerA'] }]),
    },
    dmMessages: vi.fn(async () => [
      { id: 'dm-1', agent_name: 'Lead', text: 'direct', created_at: '2026-05-27T11:10:00.000Z' },
    ]),
  };
}

function createAgentClient() {
  const anyHandlers = new Set<(event: unknown) => void>();
  return {
    anyHandlers,
    client: {
      connect: vi.fn(),
      disconnect: vi.fn(async () => undefined),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      send: vi.fn(async () => ({
        id: 'm-send',
        channel_id: 'ch-1',
        agent_id: 'agent-1',
        agent_name: 'WorkerA',
        text: 'sent',
        attachments: [],
        reactions: [],
      })),
      messages: vi.fn(async () => []),
      message: vi.fn(async () => ({ id: 'm-1', text: 'message' })),
      reply: vi.fn(async () => ({ id: 'm-reply', agent_name: 'WorkerA', text: 'reply', attachments: [] })),
      thread: vi.fn(async () => ({ parent: { id: 'm-1', text: 'parent' }, replies: [] })),
      dm: vi.fn(async () => ({
        conversation_id: 'dm-1',
        message: { id: 'dm-send', agent_name: 'WorkerA', text: 'direct', attachments: [] },
        created_at: '2026-05-27T11:20:00.000Z',
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
        createGroup: vi.fn(async () => ({
          id: 'gdm-1',
          channel_id: 'ch-gdm',
          dm_type: 'group',
          name: 'team',
          participants: [{ agent_id: 'agent-1' }, { agent_id: 'agent-2' }],
          created_at: '2026-05-27T11:25:00.000Z',
        })),
        sendMessage: vi.fn(async () => ({
          conversation_id: 'gdm-1',
          message: { id: 'gdm-send', agent_name: 'WorkerA', text: 'group direct', attachments: [] },
        })),
      },
      channels: {
        create: vi.fn(async () => ({ id: 'ch-new', name: 'new', members: [] })),
        get: vi.fn(async () => ({ id: 'ch-1', name: 'general', members: [] })),
        join: vi.fn(async () => ({ channel: 'general', agent_id: 'agent-1', already_member: false })),
        leave: vi.fn(async () => undefined),
        setTopic: vi.fn(async () => ({ id: 'ch-1', name: 'general', topic: 'topic', members: [] })),
        archive: vi.fn(async () => undefined),
        invite: vi.fn(async () => ({ channel: 'general', agent: 'WorkerB' })),
        members: vi.fn(async () => [
          { agent_id: 'agent-1', agent_name: 'WorkerA', role: 'member', is_muted: true },
        ]),
        update: vi.fn(async () => ({ id: 'ch-1', name: 'general', topic: 'updated', members: [] })),
        mute: vi.fn(async () => undefined),
        unmute: vi.fn(async () => undefined),
      },
      inbox: vi.fn(async () => ({
        unread_channels: [{ channel_name: '#general', unread_count: 3 }],
        mentions: [
          {
            id: 'm-mention',
            channel_name: '#general',
            agent_name: 'Lead',
            text: '@WorkerA',
            created_at: '2026-05-27T11:30:00.000Z',
          },
        ],
        unread_dms: [
          {
            conversation_id: 'dm-1',
            from: 'Lead',
            unread_count: 1,
            last_message: { id: 'dm-last', text: 'ping', created_at: '2026-05-27T11:31:00.000Z' },
          },
        ],
        recent_reactions: [
          {
            message_id: 'm-1',
            channel_name: '#general',
            emoji: 'eyes',
            agent_name: 'Lead',
            created_at: '2026-05-27T11:32:00.000Z',
          },
        ],
      })),
      markRead: vi.fn(async () => ({
        message_id: 'm-1',
        agent_id: 'agent-1',
        read_at: '2026-05-27T11:33:00.000Z',
      })),
      readers: vi.fn(async () => [
        { agent_id: 'agent-1', agent_name: 'WorkerA', read_at: '2026-05-27T11:33:00.000Z' },
      ]),
      readStatus: vi.fn(async () => [
        { agent_name: 'WorkerA', last_read_id: 'm-1', last_read_at: '2026-05-27T11:33:00.000Z' },
      ]),
      reactions: vi.fn(async () => [{ emoji: 'eyes', count: 2, agents: ['Lead', 'WorkerA'] }]),
      react: vi.fn(async () => ({ emoji: 'eyes', count: 1, agents: ['WorkerA'] })),
      unreact: vi.fn(async () => undefined),
      search: vi.fn(async () => [
        { id: 'm-1', channel_name: '#general', agent_name: 'Lead', text: 'hello', relevance_score: 0.9 },
      ]),
      on: {
        any: vi.fn((handler: (event: unknown) => void) => {
          anyHandlers.add(handler);
          return () => anyHandlers.delete(handler);
        }),
      },
    },
  };
}

describe('RelaycastMessagingClient', () => {
  it('exposes a public AgentRelay facade over messaging and actions', async () => {
    const workspace = createWorkspace();
    const { client: agentClient } = createAgentClient();
    const messaging = new RelaycastMessagingClient({ relaycast: workspace, agentClient });
    const actions = new ActionRegistry();
    const relay = new AgentRelay({ messaging, actions });

    expect(relay.messaging).toBe(messaging);
    // relay.messages is the enriched facade layered over the underlying client.
    expect(Object.getPrototypeOf(relay.messages)).toBe(messaging.messages);
    await expect(relay.agents.list()).resolves.toHaveLength(1);
  });

  it('agents.registerOrRotate delegates to the relaycast agents.registerOrRotate API', async () => {
    const workspace = createWorkspace();
    const registerOrRotate = vi.fn(async (input: unknown) => ({
      id: 'agent-2',
      name: (input as { name: string }).name,
      token: 'at_live_rotated',
      status: 'online',
    }));
    (
      workspace.agents as typeof workspace.agents & { registerOrRotate: typeof registerOrRotate }
    ).registerOrRotate = registerOrRotate;
    const client = new RelaycastMessagingClient({
      relaycast: workspace,
    });

    const registration = await client.agents.registerOrRotate?.({ name: 'WorkerB' });

    expect(registerOrRotate).toHaveBeenCalledWith({ name: 'WorkerB' });
    expect(workspace.agents.register).not.toHaveBeenCalled();
    expect(registration).toMatchObject({ id: 'agent-2', name: 'WorkerB', token: 'at_live_rotated' });
  });

  it('agents.registerOrRotate falls back to plain register when unsupported', async () => {
    const workspace = createWorkspace();
    const client = new RelaycastMessagingClient({ relaycast: workspace });

    const registration = await client.agents.registerOrRotate?.({ name: 'WorkerB' });

    expect(workspace.agents.register).toHaveBeenCalledWith({ name: 'WorkerB' });
    expect(registration).toMatchObject({ name: 'WorkerB', token: 'at_live_worker_b' });
  });

  it('normalizes agents, channels, and channel messages from Relaycast', async () => {
    const workspace = createWorkspace();
    const client = new RelaycastMessagingClient({ relaycast: workspace });

    const [agent] = await client.agents.list({ status: 'all' });
    expect(workspace.agents.list).toHaveBeenCalledWith({ status: 'all' });
    expect(agent).toMatchObject({
      id: 'agent-1',
      name: 'WorkerA',
      status: 'online',
      metadata: { role: 'worker' },
      channels: [{ id: 'ch-1', name: 'general', role: 'member' }],
    });

    const [channel] = await client.channels.list({ includeArchived: true });
    expect(workspace.channels.list).toHaveBeenCalledWith({ includeArchived: true });
    expect(channel).toMatchObject({
      id: 'ch-1',
      name: 'general',
      topic: 'Build room',
      memberCount: 2,
      members: [{ agentId: 'agent-1', agentName: 'WorkerA', muted: false }],
    });

    const [message] = await client.messages.list('#general', { limit: 5 });
    expect(workspace.messages.list).toHaveBeenCalledWith('general', { limit: 5 });
    expect(message).toMatchObject({
      id: 'm-1',
      kind: 'channel',
      text: 'hello',
      from: { id: 'agent-1', name: 'WorkerA' },
      channel: { id: 'ch-1', name: 'general' },
      reactions: [{ emoji: '+1', count: 1, agents: ['Lead'] }],
    });
  });

  it('delegates write operations through an agent client and normalizes responses', async () => {
    const workspace = createWorkspace();
    const { client: agentClient } = createAgentClient();
    const client = new RelaycastMessagingClient({ relaycast: workspace, agentClient });

    const sent = await client.messages.send({
      channel: '#general',
      text: 'sent',
      attachments: [{ type: 'link', url: 'https://example.com/repro', label: 'repro' }],
      mode: 'steer',
      idempotencyKey: 'idem-1',
    });
    expect(agentClient.send).toHaveBeenCalledWith('#general', 'sent', {
      attachments: ['{"type":"link","url":"https://example.com/repro","label":"repro"}'],
      mode: 'steer',
      idempotencyKey: 'idem-1',
    });
    expect(sent).toMatchObject({ id: 'm-send', kind: 'channel', channel: { name: 'general' } });

    const direct = await client.messages.direct({ to: 'Lead', text: 'direct' });
    expect(agentClient.dm).toHaveBeenCalledWith('Lead', 'direct', {});
    expect(direct).toMatchObject({
      id: 'dm-send',
      kind: 'dm',
      conversationId: 'dm-1',
      createdAt: '2026-05-27T11:20:00.000Z',
    });

    const groupDirect = await client.messages.groupDirect({
      participants: ['Lead', 'WorkerB'],
      name: 'team',
      text: 'group direct',
    });
    expect(agentClient.dms.createGroup).toHaveBeenCalledWith(
      { participants: ['Lead', 'WorkerB'], name: 'team' },
      {}
    );
    expect(agentClient.dms.sendMessage).toHaveBeenCalledWith('gdm-1', 'group direct', {});
    expect(groupDirect).toMatchObject({ id: 'gdm-send', kind: 'group_dm', conversationId: 'gdm-1' });
  });

  it('normalizes threads and inbox payloads', async () => {
    const workspace = createWorkspace();
    const { client: agentClient } = createAgentClient();
    const client = new RelaycastMessagingClient({ relaycast: workspace, agentClient });

    const thread = await client.threads.get('m-1');
    expect(thread).toEqual(normalizeThread(await workspace.messages.thread()));
    expect(thread.replies[0]).toMatchObject({
      id: 'm-2',
      kind: 'thread_reply',
      threadId: 'm-1',
      parentId: 'm-1',
    });

    const inbox = await client.inbox.get({ limit: 10 });
    expect(agentClient.inbox).toHaveBeenCalledWith({ limit: 10 });
    expect(inbox).toEqual(normalizeInbox(await agentClient.inbox()));
    expect(inbox).toMatchObject({
      unreadChannels: [{ channelName: 'general', unreadCount: 3 }],
      mentions: [{ id: 'm-mention', channel: { name: 'general' } }],
      unreadDms: [{ conversationId: 'dm-1', from: 'Lead', lastMessage: { id: 'dm-last' } }],
      recentReactions: [{ messageId: 'm-1', channelName: 'general', emoji: 'eyes' }],
    });
  });

  it('normalizes Relaycast WebSocket events behind typed messaging events', async () => {
    const workspace = createWorkspace();
    const { client: agentClient, anyHandlers } = createAgentClient();
    const client = new RelaycastMessagingClient({ relaycast: workspace, agentClient });
    const messageEvents: RelayMessagingEvent[] = [];
    const allEvents: RelayMessagingEvent[] = [];

    client.events.on('messageCreated', (event) => messageEvents.push(event));
    client.events.on('any', (event) => allEvents.push(event));

    client.events.connect();
    expect(agentClient.connect).toHaveBeenCalled();
    expect(agentClient.on.any).toHaveBeenCalled();

    for (const handler of anyHandlers) {
      handler({
        type: 'message.created',
        channel: '#general',
        message: {
          id: 'm-event',
          agent_id: 'agent-1',
          agent_name: 'WorkerA',
          text: 'event',
          attachments: [],
        },
      });
      handler({ type: 'member.channel_muted', channel: '#general', agent_name: 'WorkerA' });
    }

    expect(messageEvents).toEqual([
      normalizeMessagingEvent({
        type: 'message.created',
        channel: '#general',
        message: {
          id: 'm-event',
          agent_id: 'agent-1',
          agent_name: 'WorkerA',
          text: 'event',
          attachments: [],
        },
      }),
    ]);
    expect(allEvents.map((event) => event.type)).toEqual(['messageCreated', 'channelMuted']);

    client.events.subscribe(['#general']);
    client.events.unsubscribe(['#general']);
    expect(agentClient.subscribe).toHaveBeenCalledWith(['general']);
    expect(agentClient.unsubscribe).toHaveBeenCalledWith(['general']);

    await client.events.disconnect();
    expect(agentClient.disconnect).toHaveBeenCalled();
  });

  it('surfaces unsupported durable delivery capabilities as explicit stubs', async () => {
    const client = new RelaycastMessagingClient({ relaycast: createWorkspace() });

    expect(client.capabilities).toEqual({
      serverDeliveryState: false,
      durableDelivery: false,
      durableAck: false,
      durableFail: false,
      durableDefer: false,
    });
    await expect(client.deliveries.ack('m-1')).resolves.toMatchObject({
      supported: false,
      action: 'ack',
      messageId: 'm-1',
    });
    await expect(client.inbox.list()).resolves.toEqual({ items: [] });
  });
});

function makeDeliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del_1',
    messageId: 'm-100',
    channelId: 'ch-1',
    agentId: 'agent-1',
    status: 'accepted',
    mode: 'wait',
    reason: 'dm',
    priority: 'normal',
    retryable: null,
    error: null,
    availableAt: null,
    deadline: null,
    createdAt: '2026-06-09T10:00:00.000Z',
    updatedAt: null,
    message: {
      id: 'm-100',
      channelId: 'ch-1',
      agentId: 'agent-9',
      agentName: 'Lead',
      text: 'hello worker',
      threadId: null,
      createdAt: '2026-06-09T10:00:00.000Z',
    },
    ...overrides,
  };
}

function createDeliveryAgentClient() {
  const { client, anyHandlers } = createAgentClient();
  const agent = {
    ...client,
    deliveries: vi.fn(async () => [makeDeliveryRow()]),
    ackDelivery: vi.fn(async (id: string) => makeDeliveryRow({ id, status: 'delivered' })),
    failDelivery: vi.fn(async (id: string, options?: { error?: string; retryable?: boolean }) =>
      makeDeliveryRow({
        id,
        status: 'failed',
        error: options?.error ?? null,
        retryable: options?.retryable ?? null,
      })
    ),
    deferDelivery: vi.fn(async (id: string, options: { availableAt: string; reason?: string }) =>
      makeDeliveryRow({
        id,
        status: 'deferred',
        availableAt: options.availableAt,
        reason: options.reason ?? null,
      })
    ),
  };
  return { agent, anyHandlers };
}

describe('RelaycastMessagingClient durable deliveries', () => {
  it('reports durable delivery capabilities when the agent client exposes the ledger', () => {
    const { agent } = createDeliveryAgentClient();
    const client = new RelaycastMessagingClient({ relaycast: createWorkspace(), agentClient: agent });

    expect(client.capabilities).toEqual({
      serverDeliveryState: true,
      durableDelivery: true,
      durableAck: true,
      durableFail: true,
      durableDefer: true,
    });
  });

  it('inbox.list maps delivery ledger rows onto inbox items', async () => {
    const { agent } = createDeliveryAgentClient();
    agent.deliveries.mockResolvedValueOnce([
      makeDeliveryRow(),
      makeDeliveryRow({
        id: 'del_2',
        messageId: 'm-200',
        status: 'deferred',
        availableAt: '2026-06-09T11:00:00.000Z',
        reason: 'busy',
        message: null,
      }),
    ]);
    const client = new RelaycastMessagingClient({ relaycast: createWorkspace(), agentClient: agent });

    const result = await client.inbox.list({ agentName: 'WorkerA', limit: 25 });

    expect(agent.deliveries).toHaveBeenCalledWith({ limit: 25 });
    expect(result.nextCursor).toBeUndefined();
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: 'del_1',
      state: 'queued',
      attempts: 0,
      recipient: { name: 'WorkerA', id: 'agent-1' },
      message: {
        id: 'm-100',
        text: 'hello worker',
        from: { id: 'agent-9', name: 'Lead' },
      },
      metadata: { mode: 'wait', reason: 'dm', priority: 'normal' },
    });
    expect(result.items[0].availableAt).toBeUndefined();
    // A deferred row without an embedded message still yields a usable item.
    expect(result.items[1]).toMatchObject({
      id: 'del_2',
      state: 'deferred',
      availableAt: '2026-06-09T11:00:00.000Z',
      message: { id: 'm-200' },
      metadata: { reason: 'busy' },
    });
  });

  it('passes ack/fail/defer transitions through to the delivery ledger', async () => {
    const { agent } = createDeliveryAgentClient();
    const client = new RelaycastMessagingClient({ relaycast: createWorkspace(), agentClient: agent });

    await expect(client.inbox.ack({ inboxItemId: 'del_1' })).resolves.toEqual({
      supported: true,
      action: 'ack',
      deliveryId: 'del_1',
      messageId: 'm-100',
      state: 'delivered',
    });
    expect(agent.ackDelivery).toHaveBeenCalledWith('del_1');

    await expect(
      client.inbox.fail({ inboxItemId: 'del_1', error: 'boom', retry: true })
    ).resolves.toMatchObject({ supported: true, action: 'fail', state: 'failed' });
    expect(agent.failDelivery).toHaveBeenCalledWith('del_1', { error: 'boom', retryable: true });

    await expect(
      client.inbox.defer({ inboxItemId: 'del_1', availableAt: '2026-06-09T12:00:00.000Z', reason: 'busy' })
    ).resolves.toMatchObject({
      supported: true,
      action: 'defer',
      state: 'deferred',
      deferUntil: '2026-06-09T12:00:00.000Z',
    });
    expect(agent.deferDelivery).toHaveBeenCalledWith('del_1', {
      availableAt: '2026-06-09T12:00:00.000Z',
      reason: 'busy',
    });

    await expect(client.deliveries.ack('del_1')).resolves.toMatchObject({
      supported: true,
      action: 'ack',
      deliveryId: 'del_1',
    });
    await expect(client.deliveries.fail('del_1', 'broke')).resolves.toMatchObject({
      supported: true,
      action: 'fail',
    });
    expect(agent.failDelivery).toHaveBeenLastCalledWith('del_1', { error: 'broke' });
    await expect(client.deliveries.defer('del_1', '2026-06-09T13:00:00.000Z')).resolves.toMatchObject({
      supported: true,
      action: 'defer',
      deferUntil: '2026-06-09T13:00:00.000Z',
    });
    expect(agent.deferDelivery).toHaveBeenLastCalledWith('del_1', {
      availableAt: '2026-06-09T13:00:00.000Z',
    });

    // The ledger has no read state; markRead stays an explicit stub.
    await expect(client.inbox.markRead({ inboxItemId: 'del_1' })).resolves.toMatchObject({
      supported: false,
    });
  });

  it('propagates delivery transition errors from the underlying client', async () => {
    const { agent } = createDeliveryAgentClient();
    agent.ackDelivery.mockRejectedValueOnce(new Error('delivery not found'));
    const client = new RelaycastMessagingClient({ relaycast: createWorkspace(), agentClient: agent });

    await expect(client.inbox.ack({ inboxItemId: 'del_missing' })).rejects.toThrow('delivery not found');
  });

  it('inbox.subscribe seeds from the queue, pushes delivery.accepted events, and dedupes', async () => {
    const { agent, anyHandlers } = createDeliveryAgentClient();
    agent.deliveries
      .mockResolvedValueOnce([makeDeliveryRow()])
      .mockResolvedValue([
        makeDeliveryRow(),
        makeDeliveryRow({ id: 'del_2', messageId: 'm-200', message: null }),
      ]);
    const client = new RelaycastMessagingClient({ relaycast: createWorkspace(), agentClient: agent });

    const iterator = client.inbox.subscribe({ agentName: 'WorkerA' })[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ id: 'del_1', recipient: { name: 'WorkerA' } });
    expect(agent.connect).toHaveBeenCalled();

    for (const handler of anyHandlers) {
      // Duplicate of the seeded item: skipped before any re-listing.
      handler({ type: 'delivery.accepted', deliveryId: 'del_1', messageId: 'm-100' });
      handler({ type: 'delivery.accepted', deliveryId: 'del_2', messageId: 'm-200' });
      // Repeat announcement of the same delivery: deduped.
      handler({ type: 'delivery.accepted', deliveryId: 'del_2', messageId: 'm-200' });
    }

    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(second.value).toMatchObject({ id: 'del_2', state: 'queued' });
    // One seed list plus exactly one re-list for the new delivery id.
    expect(agent.deliveries).toHaveBeenCalledTimes(2);

    await iterator.return?.(undefined);
  });

  it('inbox.subscribe ends when the abort signal fires', async () => {
    const { agent } = createDeliveryAgentClient();
    agent.deliveries.mockResolvedValue([]);
    const client = new RelaycastMessagingClient({ relaycast: createWorkspace(), agentClient: agent });
    const controller = new AbortController();

    const iterator = client.inbox.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });
});

describe('RelaycastMessagingClient workspace stream', () => {
  it('events.connect falls back to the workspace stream when there is no agent client', () => {
    let anyHandler: ((event: unknown) => void) | undefined;
    const workspace = {
      ...createWorkspace(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      on: {
        any: vi.fn((handler: (event: unknown) => void) => {
          anyHandler = handler;
          return () => {};
        }),
      },
    };
    const client = new RelaycastMessagingClient({ relaycast: workspace });

    const received: unknown[] = [];
    client.events.on('messageCreated', (event) => received.push(event));
    client.events.connect();

    expect(workspace.connect).toHaveBeenCalledTimes(1);
    expect(workspace.on.any).toHaveBeenCalledTimes(1);

    anyHandler?.({ type: 'message.created', channel: 'general', message: { id: 'm1', text: 'hi' } });
    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe('messageCreated');
  });

  it('events.connect prefers the agent client when one is present', () => {
    const workspace = { ...createWorkspace(), connect: vi.fn(), on: { any: vi.fn(() => () => {}) } };
    const agentClient = {
      connect: vi.fn(),
      disconnect: vi.fn(async () => {}),
      on: { any: vi.fn(() => () => {}) },
    } as unknown as Parameters<typeof RelaycastMessagingClient>[0]['agentClient'];
    const client = new RelaycastMessagingClient({ relaycast: workspace, agentClient });

    client.events.connect();

    expect((agentClient as unknown as { connect: ReturnType<typeof vi.fn> }).connect).toHaveBeenCalled();
    expect(workspace.connect).not.toHaveBeenCalled();
  });
});
