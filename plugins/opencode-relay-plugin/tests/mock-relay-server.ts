import { vi } from 'vitest';

import type {
  Message,
  PluginContext,
  RelayCastFactory,
  RelayState,
  ToolDefinition,
} from '../src/index.js';

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

  /** Pending DMs that the next `inbox()` call should surface, then drain. */
  private inboxDms: QueuedDm[] = [];

  injectMessage(from: string, text: string, extra: Partial<Message> = {}): void {
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    this.messages.push({ id, from, text, ts, ...extra });
    // The engine inbox exposes DMs (and channel mentions); model these as DMs.
    this.inboxDms.push({ id, from, text, ts });
  }

  record(endpoint: string, body: Record<string, unknown>): void {
    this.requests.push({ endpoint, body });
  }

  drainInbox() {
    const mentions = this.inboxDms
      .filter((m) => 'channel' in m)
      .map((m) => ({
        id: m.id,
        channelName: '',
        agentName: m.from,
        text: m.text,
        createdAt: m.ts,
      }));

    const unreadDms = this.inboxDms.map((m) => ({
      conversationId: `conv-${m.from}`,
      from: m.from,
      unreadCount: 1,
      lastMessage: { id: m.id, text: m.text, createdAt: m.ts },
    }));

    this.inboxDms = [];

    return {
      unreadChannels: [],
      mentions,
      unreadDms,
      recentReactions: [],
    };
  }
}

class MockAgentClient {
  constructor(private readonly server: MockRelayServer) {}

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

  async inbox() {
    this.server.record('inbox/check', {});
    return this.server.drainInbox();
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
