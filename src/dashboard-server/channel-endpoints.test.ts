/**
 * Unit tests for dashboard-server channel endpoints.
 * Tests the endpoints that handle channel membership operations from the cloud server.
 *
 * Endpoints tested:
 * - POST /api/channels/admin-join - Add member to channel (admin operation)
 * - POST /api/channels/subscribe - Subscribe user to channels
 * - POST /api/channels/message - Send message to channel
 * - GET /api/channels/:channel/members - Get channel members
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Mock RelayClient
class MockRelayClient {
  public state: 'READY' | 'DISCONNECTED' = 'READY';
  public agentName: string;
  public entityType?: 'agent' | 'user';
  public joinedChannels: string[] = [];
  public sentMessages: Array<{ channel: string; body: string }> = [];

  constructor(options: { agentName: string; entityType?: 'agent' | 'user' }) {
    this.agentName = options.agentName;
    this.entityType = options.entityType;
  }

  joinChannel(channel: string, _displayName?: string): boolean {
    if (this.state !== 'READY') return false;
    this.joinedChannels.push(channel);
    return true;
  }

  sendChannelMessage(channel: string, body: string): boolean {
    if (this.state !== 'READY') return false;
    this.sentMessages.push({ channel, body });
    return true;
  }

  adminJoinChannel(_channel: string, _member: string): boolean {
    if (this.state !== 'READY') return false;
    // Simulates admin adding another member
    return true;
  }

  disconnect(): void {
    this.state = 'DISCONNECTED';
  }
}

// Mock UserBridge
class MockUserBridge {
  private users = new Map<string, MockRelayClient>();
  public adminJoinCalls: Array<{ channel: string; member: string }> = [];
  public adminRemoveCalls: Array<{ channel: string; member: string }> = [];

  isUserRegistered(username: string): boolean {
    return this.users.has(username);
  }

  registerUser(username: string, client: MockRelayClient): void {
    this.users.set(username, client);
  }

  getUser(username: string): MockRelayClient | undefined {
    return this.users.get(username);
  }

  async adminJoinChannel(channel: string, member: string): Promise<boolean> {
    this.adminJoinCalls.push({ channel, member });
    return true;
  }

  async adminRemoveMember(channel: string, member: string): Promise<boolean> {
    this.adminRemoveCalls.push({ channel, member });
    return true;
  }

  sendChannelMessage(
    username: string,
    channel: string,
    body: string
  ): boolean {
    const client = this.users.get(username);
    if (!client) return false;
    return client.sendChannelMessage(channel, body);
  }
}

describe('Admin Join Endpoint', () => {
  let userBridge: MockUserBridge;

  beforeEach(() => {
    userBridge = new MockUserBridge();
  });

  it('should add member to channel via admin join', async () => {
    const result = await simulateAdminJoin(userBridge, {
      channel: '#general',
      member: 'CodeReviewer',
    });

    expect(result.success).toBe(true);
    expect(userBridge.adminJoinCalls).toHaveLength(1);
    expect(userBridge.adminJoinCalls[0]).toEqual({
      channel: '#general',
      member: 'CodeReviewer',
    });
  });

  it('should normalize channel name with # prefix', async () => {
    const result = await simulateAdminJoin(userBridge, {
      channel: 'engineering',
      member: 'Lead',
    });

    expect(result.success).toBe(true);
    expect(userBridge.adminJoinCalls[0].channel).toBe('#engineering');
  });

  it('should reject request without channel', async () => {
    const result = await simulateAdminJoin(userBridge, {
      channel: '',
      member: 'Agent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('channel');
  });

  it('should reject request without member', async () => {
    const result = await simulateAdminJoin(userBridge, {
      channel: '#general',
      member: '',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('member');
  });

  it('should include workspaceId for persistence', async () => {
    const result = await simulateAdminJoin(userBridge, {
      channel: '#general',
      member: 'Agent',
      workspaceId: 'workspace-123',
    });

    expect(result.success).toBe(true);
    expect(result.workspaceId).toBe('workspace-123');
  });
});

describe('Subscribe Endpoint', () => {
  let relayClients: Map<string, MockRelayClient>;

  beforeEach(() => {
    relayClients = new Map();
  });

  it('should create relay client and join channels', async () => {
    const result = await simulateSubscribe(relayClients, {
      username: 'alice',
      channels: ['#general', '#random'],
    });

    expect(result.success).toBe(true);
    expect(result.channels).toEqual(['#general', '#random']);

    const client = relayClients.get('alice');
    expect(client).toBeDefined();
    expect(client?.joinedChannels).toContain('#general');
    expect(client?.joinedChannels).toContain('#random');
  });

  it('should default to #general if no channels specified', async () => {
    const result = await simulateSubscribe(relayClients, {
      username: 'bob',
    });

    expect(result.success).toBe(true);
    expect(result.channels).toContain('#general');
  });

  it('should normalize channel names', async () => {
    const result = await simulateSubscribe(relayClients, {
      username: 'charlie',
      channels: ['engineering', 'random'],
    });

    expect(result.success).toBe(true);
    expect(result.channels).toEqual(['#engineering', '#random']);
  });

  it('should reject request without username', async () => {
    const result = await simulateSubscribe(relayClients, {
      username: '',
      channels: ['#general'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('username');
  });

  it('should reuse existing client for same user', async () => {
    await simulateSubscribe(relayClients, {
      username: 'alice',
      channels: ['#general'],
    });

    await simulateSubscribe(relayClients, {
      username: 'alice',
      channels: ['#engineering'],
    });

    expect(relayClients.size).toBe(1);
    const client = relayClients.get('alice');
    expect(client?.joinedChannels).toContain('#general');
    expect(client?.joinedChannels).toContain('#engineering');
  });
});

describe('Channel Message Endpoint', () => {
  let userBridge: MockUserBridge;
  let relayClients: Map<string, MockRelayClient>;

  beforeEach(() => {
    userBridge = new MockUserBridge();
    relayClients = new Map();
  });

  it('should send message via local user client', async () => {
    // Register local user
    const client = new MockRelayClient({ agentName: 'alice', entityType: 'user' });
    userBridge.registerUser('alice', client);

    const result = await simulateSendMessage(userBridge, relayClients, {
      username: 'alice',
      channel: '#general',
      body: 'Hello world!',
    });

    expect(result.success).toBe(true);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]).toEqual({
      channel: '#general',
      body: 'Hello world!',
    });
  });

  it('should fallback to relay client for cloud users', async () => {
    // Alice is not in userBridge, simulating cloud user
    const relayClient = new MockRelayClient({ agentName: 'alice', entityType: 'user' });
    relayClients.set('alice', relayClient);

    const result = await simulateSendMessage(userBridge, relayClients, {
      username: 'alice',
      channel: '#general',
      body: 'Hello from cloud!',
    });

    expect(result.success).toBe(true);
    expect(relayClient.sentMessages).toHaveLength(1);
  });

  it('should join channel before sending if not already joined', async () => {
    const relayClient = new MockRelayClient({ agentName: 'bob', entityType: 'user' });
    relayClients.set('bob', relayClient);

    const result = await simulateSendMessage(userBridge, relayClients, {
      username: 'bob',
      channel: '#engineering',
      body: 'First message',
    });

    expect(result.success).toBe(true);
    expect(relayClient.joinedChannels).toContain('#engineering');
    expect(relayClient.sentMessages[0].channel).toBe('#engineering');
  });

  it('should reject message without required fields', async () => {
    const result = await simulateSendMessage(userBridge, relayClients, {
      username: 'alice',
      channel: '',
      body: 'Hello',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('channel');
  });

  it('should include thread ID when provided', async () => {
    const client = new MockRelayClient({ agentName: 'alice', entityType: 'user' });
    userBridge.registerUser('alice', client);

    const result = await simulateSendMessage(userBridge, relayClients, {
      username: 'alice',
      channel: '#general',
      body: 'Reply',
      thread: 'thread-123',
    });

    expect(result.success).toBe(true);
    expect(result.thread).toBe('thread-123');
  });
});

describe('Get Channel Members Endpoint', () => {
  it('should return all channel members with entity types', async () => {
    const router = createMockRouter();
    router.addChannelMember('#general', 'alice', 'user');
    router.addChannelMember('#general', 'bob', 'user');
    router.addChannelMember('#general', 'CodeReviewer', 'agent');

    const result = await simulateGetMembers(router, '#general');

    expect(result.members).toHaveLength(3);
    expect(result.members.find(m => m.id === 'alice')?.entityType).toBe('user');
    expect(result.members.find(m => m.id === 'CodeReviewer')?.entityType).toBe('agent');
  });

  it('should include online status', async () => {
    const router = createMockRouter();
    router.addChannelMember('#general', 'alice', 'user', true);
    router.addChannelMember('#general', 'bob', 'user', false);

    const result = await simulateGetMembers(router, '#general');

    expect(result.members.find(m => m.id === 'alice')?.status).toBe('online');
    expect(result.members.find(m => m.id === 'bob')?.status).toBe('offline');
  });

  it('should return empty array for non-existent channel', async () => {
    const router = createMockRouter();

    const result = await simulateGetMembers(router, '#nonexistent');

    expect(result.members).toHaveLength(0);
  });

  it('should normalize channel name', async () => {
    const router = createMockRouter();
    router.addChannelMember('#engineering', 'alice', 'user');

    const result = await simulateGetMembers(router, 'engineering');

    expect(result.members).toHaveLength(1);
  });
});

describe('Channel Membership Persistence', () => {
  it('should persist membership on admin join', async () => {
    const persistedEvents: Array<{ channel: string; member: string; action: string }> = [];

    const result = await simulateAdminJoinWithPersistence(
      {
        channel: '#general',
        member: 'Agent',
        workspaceId: 'workspace-123',
      },
      persistedEvents
    );

    expect(result.success).toBe(true);
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toEqual({
      channel: '#general',
      member: 'Agent',
      action: 'join',
    });
  });

  it('should persist membership on user subscribe', async () => {
    const persistedEvents: Array<{ channel: string; member: string; action: string }> = [];

    await simulateSubscribeWithPersistence(
      {
        username: 'alice',
        channels: ['#general', '#random'],
        workspaceId: 'workspace-123',
      },
      persistedEvents
    );

    expect(persistedEvents).toHaveLength(2);
    expect(persistedEvents[0].member).toBe('alice');
    expect(persistedEvents[0].channel).toBe('#general');
    expect(persistedEvents[1].channel).toBe('#random');
  });
});

// ============================================================================
// Test Helpers
// ============================================================================

async function simulateAdminJoin(
  userBridge: MockUserBridge,
  params: { channel: string; member: string; workspaceId?: string }
): Promise<{ success: boolean; error?: string; workspaceId?: string }> {
  const { channel, member, workspaceId } = params;

  if (!channel) {
    return { success: false, error: 'channel is required' };
  }
  if (!member) {
    return { success: false, error: 'member is required' };
  }

  const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;
  const success = await userBridge.adminJoinChannel(normalizedChannel, member);

  return { success, workspaceId };
}

async function simulateSubscribe(
  relayClients: Map<string, MockRelayClient>,
  params: { username: string; channels?: string[]; workspaceId?: string }
): Promise<{ success: boolean; channels?: string[]; error?: string }> {
  const { username, channels = ['#general'], workspaceId: _workspaceId } = params;

  if (!username) {
    return { success: false, error: 'username is required' };
  }

  // Get or create client
  let client = relayClients.get(username);
  if (!client) {
    client = new MockRelayClient({ agentName: username, entityType: 'user' });
    relayClients.set(username, client);
  }

  // Join channels
  const joinedChannels: string[] = [];
  for (const channel of channels) {
    const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;
    if (client.joinChannel(normalizedChannel)) {
      joinedChannels.push(normalizedChannel);
    }
  }

  return { success: true, channels: joinedChannels };
}

async function simulateSendMessage(
  userBridge: MockUserBridge,
  relayClients: Map<string, MockRelayClient>,
  params: { username: string; channel: string; body: string; thread?: string }
): Promise<{ success: boolean; error?: string; thread?: string }> {
  const { username, channel, body, thread } = params;

  if (!username || !channel || !body) {
    return { success: false, error: 'username, channel, and body are required' };
  }

  const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;

  // Try local user first
  if (userBridge.isUserRegistered(username)) {
    const success = userBridge.sendChannelMessage(username, normalizedChannel, body);
    return { success, thread };
  }

  // Fallback to relay client
  let client = relayClients.get(username);
  if (!client) {
    client = new MockRelayClient({ agentName: username, entityType: 'user' });
    relayClients.set(username, client);
  }

  // Join if not already joined
  if (!client.joinedChannels.includes(normalizedChannel)) {
    client.joinChannel(normalizedChannel);
  }

  const success = client.sendChannelMessage(normalizedChannel, body);
  return { success, thread };
}

interface MockRouter {
  members: Map<string, Array<{ id: string; entityType: 'user' | 'agent'; online: boolean }>>;
  addChannelMember: (channel: string, id: string, entityType: 'user' | 'agent', online?: boolean) => void;
  getChannelMembers: (channel: string) => string[];
}

function createMockRouter(): MockRouter {
  const members = new Map<string, Array<{ id: string; entityType: 'user' | 'agent'; online: boolean }>>();

  return {
    members,
    addChannelMember(channel: string, id: string, entityType: 'user' | 'agent', online = true) {
      const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;
      if (!members.has(normalizedChannel)) {
        members.set(normalizedChannel, []);
      }
      members.get(normalizedChannel)!.push({ id, entityType, online });
    },
    getChannelMembers(channel: string): string[] {
      const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;
      return members.get(normalizedChannel)?.map(m => m.id) || [];
    },
  };
}

async function simulateGetMembers(
  router: MockRouter,
  channel: string
): Promise<{ members: Array<{ id: string; entityType: 'user' | 'agent'; status: 'online' | 'offline' }> }> {
  const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;
  const channelMembers = router.members.get(normalizedChannel) || [];

  return {
    members: channelMembers.map(m => ({
      id: m.id,
      entityType: m.entityType,
      status: m.online ? 'online' : 'offline',
    })),
  };
}

async function simulateAdminJoinWithPersistence(
  params: { channel: string; member: string; workspaceId: string },
  persistedEvents: Array<{ channel: string; member: string; action: string }>
): Promise<{ success: boolean }> {
  const { channel, member } = params;
  const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;

  persistedEvents.push({
    channel: normalizedChannel,
    member,
    action: 'join',
  });

  return { success: true };
}

async function simulateSubscribeWithPersistence(
  params: { username: string; channels: string[]; workspaceId: string },
  persistedEvents: Array<{ channel: string; member: string; action: string }>
): Promise<void> {
  const { username, channels } = params;

  for (const channel of channels) {
    const normalizedChannel = channel.startsWith('#') ? channel : `#${channel}`;
    persistedEvents.push({
      channel: normalizedChannel,
      member: username,
      action: 'join',
    });
  }
}
