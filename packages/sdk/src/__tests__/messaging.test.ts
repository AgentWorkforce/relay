import { describe, expect, it, vi } from 'vitest';

import {
  RelaycastMessagingClient,
  normalizeInbox,
  normalizeMessagingEvent,
  normalizeThread,
  type RelayMessagingEvent,
} from '../messaging/index.js';

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
      update: vi.fn(async (_name: string, input: unknown) => ({ id: 'agent-1', name: 'WorkerA', type: 'agent', ...input })),
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
          members: [{ agent_id: 'agent-1', agent_name: 'WorkerA', role: 'member', joined_at: '2026-05-27T09:00:00.000Z' }],
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
        replies: [{ id: 'm-2', agent_name: 'WorkerA', text: 'reply', attachments: [], created_at: '2026-05-27T11:05:00.000Z' }],
      })),
      reactions: vi.fn(async () => [{ emoji: 'eyes', count: 2, agents: ['Lead', 'WorkerA'] }]),
    },
    dmMessages: vi.fn(async () => [{ id: 'dm-1', agent_name: 'Lead', text: 'direct', created_at: '2026-05-27T11:10:00.000Z' }]),
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
        members: vi.fn(async () => [{ agent_id: 'agent-1', agent_name: 'WorkerA', role: 'member', is_muted: true }]),
        update: vi.fn(async () => ({ id: 'ch-1', name: 'general', topic: 'updated', members: [] })),
        mute: vi.fn(async () => undefined),
        unmute: vi.fn(async () => undefined),
      },
      inbox: vi.fn(async () => ({
        unread_channels: [{ channel_name: '#general', unread_count: 3 }],
        mentions: [{ id: 'm-mention', channel_name: '#general', agent_name: 'Lead', text: '@WorkerA', created_at: '2026-05-27T11:30:00.000Z' }],
        unread_dms: [{ conversation_id: 'dm-1', from: 'Lead', unread_count: 1, last_message: { id: 'dm-last', text: 'ping', created_at: '2026-05-27T11:31:00.000Z' } }],
        recent_reactions: [{ message_id: 'm-1', channel_name: '#general', emoji: 'eyes', agent_name: 'Lead', created_at: '2026-05-27T11:32:00.000Z' }],
      })),
      markRead: vi.fn(async () => ({ message_id: 'm-1', agent_id: 'agent-1', read_at: '2026-05-27T11:33:00.000Z' })),
      readers: vi.fn(async () => [{ agent_id: 'agent-1', agent_name: 'WorkerA', read_at: '2026-05-27T11:33:00.000Z' }]),
      readStatus: vi.fn(async () => [{ agent_name: 'WorkerA', last_read_id: 'm-1', last_read_at: '2026-05-27T11:33:00.000Z' }]),
      reactions: vi.fn(async () => [{ emoji: 'eyes', count: 2, agents: ['Lead', 'WorkerA'] }]),
      react: vi.fn(async () => ({ emoji: 'eyes', count: 1, agents: ['WorkerA'] })),
      unreact: vi.fn(async () => undefined),
      search: vi.fn(async () => [{ id: 'm-1', channel_name: '#general', agent_name: 'Lead', text: 'hello', relevance_score: 0.9 }]),
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
      mode: 'steer',
      idempotencyKey: 'idem-1',
    });
    expect(agentClient.send).toHaveBeenCalledWith('#general', 'sent', { mode: 'steer', idempotencyKey: 'idem-1' });
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
    expect(agentClient.dms.createGroup).toHaveBeenCalledWith({ participants: ['Lead', 'WorkerB'], name: 'team' }, {});
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
        message: { id: 'm-event', agent_id: 'agent-1', agent_name: 'WorkerA', text: 'event', attachments: [] },
      });
      handler({ type: 'member.channel_muted', channel: '#general', agent_name: 'WorkerA' });
    }

    expect(messageEvents).toEqual([
      normalizeMessagingEvent({
        type: 'message.created',
        channel: '#general',
        message: { id: 'm-event', agent_id: 'agent-1', agent_name: 'WorkerA', text: 'event', attachments: [] },
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
  });
});
