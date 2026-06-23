import { vi } from 'vitest';

import type { Message, PluginContext, RelayCastFactory, RelayState, ToolDefinition } from '../src/index.js';

/**
 * Records every call the plugin makes through the SDK, keyed by a stable
 * `endpoint` label so tests can assert on transport behavior the same way they
 * did against the old bespoke HTTP server.
 */
export interface MockRequest {
  endpoint: string;
  body: Record<string, unknown>;
}

interface QueuedDm {
  id: string;
  from: string;
  text: string;
  ts: string;
  channel?: string;
  conversationId?: string;
}

/**
 * In-memory stand-in for the relaycast engine. It models just enough of the
 * RelayCast (workspace) + AgentClient (agent) surface that the plugin touches,
 * and exposes the recorded request log + an inbox queue for assertions.
 */
export class MockRelayServer {
  messages: Message[] = [];
  agents: string[] = [];
  requests: MockRequest[] = [];
  registerShouldFail = false;

  /**
   * Unread items the engine inbox reports. The engine inbox is *read-only*: it
   * keeps reporting these until the agent acks each one via `markRead`. We model
   * that here so tests exercise the plugin's drain (markRead + watermark) path.
   */
  private inboxItems: QueuedDm[] = [];
  /** Message IDs the agent has acked via markRead. */
  readMessageIds = new Set<string>();

  injectMessage(from: string, text: string, extra: Partial<Message> = {}): void {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    this.messages.push({ id, from, text, ts, ...extra });
    // The engine inbox exposes DMs (and channel mentions); model these as DMs.
    this.inboxItems.push({ id, from, text, ts, conversationId: `conv-${from}` });
  }

  /** Inject a channel mention (surfaces under inbox `mentions`). */
  injectMention(from: string, channel: string, text: string): string {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    this.inboxItems.push({ id, from, text, ts, channel });
    return id;
  }

  /** Inject a DM into an explicit conversation (for multi-message DM tests). */
  injectDm(from: string, conversationId: string, text: string): string {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    this.inboxItems.push({ id, from, text, ts, conversationId });
    return id;
  }

  /** Inject an unread channel post that does NOT mention the reader. */
  injectChannelPost(from: string, channel: string, text: string): string {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    // No `mention` flag: lands under unread_channels, not mentions.
    this.inboxItems.push({ id, from, text, ts, channel, conversationId: undefined });
    // Tag as a non-mention channel post via a sentinel on the object.
    (this.inboxItems[this.inboxItems.length - 1] as QueuedDm & { channelPost?: boolean }).channelPost =
      true;
    return id;
  }

  record(endpoint: string, body: Record<string, unknown>): void {
    this.requests.push({ endpoint, body });
  }

  /** All unacked items for a given conversation, oldest-first. */
  conversationMessages(conversationId: string): QueuedDm[] {
    return this.inboxItems.filter(
      (m) => m.conversationId === conversationId && !this.readMessageIds.has(m.id)
    );
  }

  /** All unacked posts for a given channel, oldest-first. */
  channelMessages(channel: string): QueuedDm[] {
    return this.inboxItems.filter((m) => m.channel === channel && !this.readMessageIds.has(m.id));
  }

  markRead(messageId: string): void {
    this.readMessageIds.add(messageId);
  }

  /** Build the engine inbox *summary* from current unacked items (read-only). */
  buildInbox() {
    const unread = this.inboxItems.filter((m) => !this.readMessageIds.has(m.id));

    const mentions = unread
      .filter((m) => m.channel && !(m as QueuedDm & { channelPost?: boolean }).channelPost)
      .map((m) => ({
        id: m.id,
        channelName: m.channel ?? '',
        agentName: m.from,
        text: m.text,
        createdAt: m.ts,
      }));

    // Group DM items by conversation; summary carries only the last message.
    const dmConvIds = [
      ...new Set(unread.filter((m) => m.conversationId).map((m) => m.conversationId as string)),
    ];
    const unreadDms = dmConvIds.map((conversationId) => {
      const items = unread.filter((m) => m.conversationId === conversationId);
      const last = items[items.length - 1];
      return {
        conversationId,
        from: last.from,
        unreadCount: items.length,
        lastMessage: { id: last.id, text: last.text, createdAt: last.ts },
      };
    });

    // Channel posts (non-mentions) only surface as an unread count in summary.
    const channelPosts = unread.filter(
      (m) => m.channel && (m as QueuedDm & { channelPost?: boolean }).channelPost
    );
    const channelNames = [...new Set(channelPosts.map((m) => m.channel as string))];
    const unreadChannels = channelNames.map((channelName) => ({
      channelName,
      unreadCount: channelPosts.filter((m) => m.channel === channelName).length,
    }));

    return {
      unreadChannels,
      mentions,
      unreadDms,
      recentReactions: [],
    };
  }
}

class MockAgentClient {
  dms: {
    messages: (conversationId: string, opts?: { limit?: number }) => Promise<unknown[]>;
  };

  constructor(private readonly server: MockRelayServer) {
    this.dms = {
      // Returns newest-first, mirroring the engine contract.
      messages: async (conversationId, opts) => {
        this.server.record('dm/messages', { conversationId, limit: opts?.limit ?? null });
        const items = this.server.conversationMessages(conversationId).slice().reverse();
        const limit = opts?.limit ?? items.length;
        return items.slice(0, limit).map((m) => ({
          id: m.id,
          agentId: m.from,
          agentName: m.from,
          text: m.text,
          createdAt: m.ts,
        }));
      },
    };
  }

  async dm(agent: string, text: string) {
    this.server.record('dm/send', { to: agent, text });
    return {
      conversationId: `conv-${agent}`,
      message: { id: crypto.randomUUID(), agentId: 'self', agentName: 'self', text },
      createdAt: new Date().toISOString(),
    };
  }

  async post(channel: string, text: string) {
    this.server.record('message/post', { channel, text });
    return { id: crypto.randomUUID(), channel, text };
  }

  // Channel message listing, newest-first.
  async messages(channel: string, opts?: { limit?: number }) {
    this.server.record('message/list', { channel, limit: opts?.limit ?? null });
    const items = this.server.channelMessages(channel).slice().reverse();
    const limit = opts?.limit ?? items.length;
    return items.slice(0, limit).map((m) => ({
      id: m.id,
      channelId: channel,
      agentId: m.from,
      agentName: m.from,
      text: m.text,
      createdAt: m.ts,
    }));
  }

  async inbox() {
    this.server.record('inbox/check', {});
    return this.server.buildInbox();
  }

  async markRead(messageId: string) {
    this.server.record('message/read', { messageId });
    this.server.markRead(messageId);
    return { messageId, readAt: new Date().toISOString() };
  }
}

class MockRelayCast {
  agents: {
    list: () => Promise<unknown[]>;
    registerOrGet: (data: { name: string; metadata?: Record<string, unknown> }) => Promise<unknown>;
    delete: (name: string) => Promise<void>;
  };

  private agentClient: MockAgentClient;

  constructor(private readonly server: MockRelayServer) {
    this.agentClient = new MockAgentClient(server);
    this.agents = {
      list: async () => {
        server.record('agent/list', {});
        return server.agents;
      },
      registerOrGet: async (data) => {
        server.record('agent/add', { name: data.name, ...(data.metadata ?? {}) });
        if (typeof data.name === 'string' && !server.agents.includes(data.name)) {
          server.agents.push(data.name);
        }
        return { id: crypto.randomUUID(), name: data.name, token: 'worker-token', status: 'online' };
      },
      delete: async (name) => {
        server.record('agent/remove', { name });
        server.agents = server.agents.filter((a) => a !== name);
      },
    };
  }

  async registerOrRotate(data: { name: string }) {
    this.server.record('register', { name: data.name, workspace: this.apiKey, cli: 'opencode' });
    if (this.server.registerShouldFail) {
      throw new Error('register failed');
    }
    return {
      id: crypto.randomUUID(),
      name: data.name,
      token: 'test-token-123',
      status: 'online',
      createdAt: new Date().toISOString(),
    };
  }

  apiKey = '';

  as(_token: string) {
    return this.agentClient;
  }
}

export function createMockRelayCastFactory(server: MockRelayServer): RelayCastFactory {
  return vi.fn((options: { apiKey: string }) => {
    const relay = new MockRelayCast(server);
    relay.apiKey = options.apiKey;
    return relay as unknown as ReturnType<RelayCastFactory>;
  }) as unknown as RelayCastFactory;
}

export function createPluginContext() {
  const tools = new Map<string, ToolDefinition<unknown, unknown>>();
  const ctx: PluginContext = {
    tool(definition) {
      tools.set(definition.name, definition);
    },
  };

  return { ctx, tools };
}

/**
 * Connect a RelayState directly against the mock SDK (skips the real connect
 * handler) for tests that start from an already-connected state.
 */
export function connectRelayState(state: RelayState, server: MockRelayServer): RelayState {
  const relay = new MockRelayCast(server);
  relay.apiKey = 'rk_live_test_workspace';
  state.agentName = 'Lead';
  state.workspace = 'rk_live_test_workspace';
  state.token = 'test-token-123';
  state.relay = relay as unknown as RelayState['relay'];
  state.agent = relay.as('test-token-123') as unknown as RelayState['agent'];
  state.connected = true;
  return state;
}
