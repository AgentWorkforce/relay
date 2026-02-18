import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock createRelaycastClient before importing the adapter
vi.mock('@agent-relay/broker-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-relay/broker-sdk')>();
  return {
    ...actual,
    createRelaycastClient: vi.fn(),
  };
});

import { createRelayClientAdapter, type RelayClient } from '../src/client-adapter.js';
import { createRelaycastClient } from '@agent-relay/broker-sdk';

const mockCreateRelaycastClient = vi.mocked(createRelaycastClient);

/**
 * Mock AgentRelayClient (broker-sdk) for testing the adapter layer.
 * The adapter wraps broker-sdk methods and translates between MCP and broker-sdk interfaces.
 */
function createMockBrokerClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ event_id: 'evt-1', targets: ['target'] }),
    spawnPty: vi.fn().mockResolvedValue({ name: 'Worker', runtime: 'pty' }),
    release: vi.fn().mockResolvedValue({ name: 'Worker' }),
    listAgents: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({ agents: 0, pending: 0 }),
    getMetrics: vi.fn().mockResolvedValue({ agents: [] }),
    setModel: vi.fn().mockResolvedValue({ success: true, name: 'Worker', model: 'opus' }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockRelaycastAgent() {
  return {
    inbox: vi.fn().mockResolvedValue({ mentions: [], unread_dms: [], unread_channels: [] }),
    client: {
      get: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('RelayClient Adapter', () => {
  let mockBrokerClient: ReturnType<typeof createMockBrokerClient>;
  let mockRelaycastAgent: ReturnType<typeof createMockRelaycastAgent>;
  let client: RelayClient;

  beforeEach(() => {
    mockBrokerClient = createMockBrokerClient();
    mockRelaycastAgent = createMockRelaycastAgent();
    mockCreateRelaycastClient.mockResolvedValue(mockRelaycastAgent as any);
    client = createRelayClientAdapter(mockBrokerClient as any, {
      agentName: 'test-agent',
      socketPath: '/tmp/test.sock',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('send', () => {
    it('sends a message to target', async () => {
      await client.send('Alice', 'Hello');

      // Adapter calls broker sendMessage with object
      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: 'Alice',
        text: 'Hello',
        from: 'test-agent',
        threadId: undefined,
      });
    });

    it('sends a message with thread', async () => {
      await client.send('Worker', 'Continue', { thread: 'task-123' });

      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: 'Worker',
        text: 'Continue',
        from: 'test-agent',
        threadId: 'task-123',
      });
    });

    it('sends a message with custom kind and data', async () => {
      // Note: broker-sdk sendMessage doesn't support kind/data, but the adapter
      // accepts the options for interface compatibility and sends the text
      await client.send('Bob', 'Status update', { kind: 'status', data: { progress: 50 } });

      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: 'Bob',
        text: 'Status update',
        from: 'test-agent',
        threadId: undefined,
      });
    });
  });

  describe('broadcast', () => {
    it('broadcasts to all agents', async () => {
      await client.broadcast('Hello everyone');

      // Adapter sends to '*' via sendMessage
      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: '*',
        text: 'Hello everyone',
        from: 'test-agent',
      });
    });

    it('broadcasts with custom kind', async () => {
      await client.broadcast('System notice', { kind: 'alert' });

      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: '*',
        text: 'System notice',
        from: 'test-agent',
      });
    });
  });

  describe('spawn', () => {
    it('spawns a worker with basic options', async () => {
      mockBrokerClient.spawnPty.mockResolvedValue({ name: 'Worker1', runtime: 'pty' });

      const result = await client.spawn({
        name: 'Worker1',
        cli: 'claude',
        task: 'Test task',
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe('Worker1');
      expect(mockBrokerClient.spawnPty).toHaveBeenCalledWith({
        name: 'Worker1',
        cli: 'claude',
        task: 'Test task',
        model: undefined,
        cwd: undefined,
        channels: ['general'],
      });
    });

    it('spawns a worker with all options', async () => {
      mockBrokerClient.spawnPty.mockResolvedValue({ name: 'TestWorker', runtime: 'pty' });

      const result = await client.spawn({
        name: 'TestWorker',
        cli: 'codex',
        task: 'Complex task',
        model: 'gpt-4',
        cwd: '/tmp/project',
      });

      expect(result.success).toBe(true);
      expect(mockBrokerClient.spawnPty).toHaveBeenCalledWith({
        name: 'TestWorker',
        cli: 'codex',
        task: 'Complex task',
        model: 'gpt-4',
        cwd: '/tmp/project',
        channels: ['general'],
      });
    });

    it('handles spawn failure', async () => {
      mockBrokerClient.spawnPty.mockRejectedValue(new Error('Out of resources'));

      const result = await client.spawn({
        name: 'FailWorker',
        cli: 'claude',
        task: 'Will fail',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Out of resources');
    });
  });

  describe('release', () => {
    it('releases a worker', async () => {
      mockBrokerClient.release.mockResolvedValue({ name: 'Worker1' });

      const result = await client.release('Worker1');

      expect(result.success).toBe(true);
      expect(mockBrokerClient.release).toHaveBeenCalledWith('Worker1', undefined);
    });

    it('releases a worker with reason', async () => {
      mockBrokerClient.release.mockResolvedValue({ name: 'Worker1' });

      const result = await client.release('Worker1', 'task completed');

      expect(result.success).toBe(true);
      expect(mockBrokerClient.release).toHaveBeenCalledWith('Worker1', 'task completed');
    });

    it('handles release failure', async () => {
      mockBrokerClient.release.mockRejectedValue(new Error('Agent not found'));

      const result = await client.release('NonExistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
    });
  });

  describe('getInbox', () => {
    it('returns empty inbox', async () => {
      mockRelaycastAgent.inbox.mockResolvedValue({
        mentions: [],
        unread_dms: [],
        unread_channels: [],
      });

      const inbox = await client.getInbox();

      expect(inbox).toEqual([]);
    });

    it('maps inbox messages correctly', async () => {
      mockRelaycastAgent.inbox.mockResolvedValue({
        mentions: [
          { id: '1', channel_name: '#team', agent_name: 'Alice', text: 'Hi there', created_at: '2024-01-01T00:00:00Z' },
        ],
        unread_dms: [
          { conversation_id: 'conv-2', from: 'Bob', unread_count: 1, last_message: 'Hello' },
        ],
        unread_channels: [],
      });

      const inbox = await client.getInbox();

      expect(inbox).toHaveLength(2);
      expect(inbox[0]).toEqual({
        id: '1',
        from: 'Alice',
        content: 'Hi there',
        channel: '#team',
        thread: undefined,
      });
      expect(inbox[1]).toEqual({
        id: expect.stringContaining('dm:conv-2'),
        from: 'Bob',
        content: 'Hello',
        channel: undefined,
        thread: undefined,
      });
    });

    it('passes filter options', async () => {
      mockRelaycastAgent.inbox.mockResolvedValue({
        mentions: [
          { id: '1', channel_name: '#team', agent_name: 'Alice', text: 'Msg 1', created_at: '2024-01-01T00:00:00Z' },
          { id: '2', channel_name: '#team', agent_name: 'Bob', text: 'Msg 2', created_at: '2024-01-01T00:00:01Z' },
        ],
        unread_dms: [],
        unread_channels: [],
      });

      const inbox = await client.getInbox({ limit: 10, unread_only: true, from: 'Alice' });

      // Adapter filters by from client-side
      expect(inbox).toHaveLength(1);
      expect(inbox[0].from).toBe('Alice');
    });
  });

  describe('listAgents', () => {
    it('returns list of agents', async () => {
      mockBrokerClient.listAgents.mockResolvedValue([
        { name: 'Orchestrator', runtime: 'headless_claude', parent: undefined, pid: 100 },
        { name: 'Worker1', runtime: 'pty', parent: 'Orchestrator', pid: 101 },
        { name: 'Worker2', runtime: 'pty', parent: 'Orchestrator', pid: 102 },
      ]);

      const agents = await client.listAgents({ include_idle: true });

      expect(agents).toHaveLength(3);
      expect(agents[0].name).toBe('Orchestrator');
      expect(agents[0].cli).toBe('claude'); // headless_claude maps to 'claude'
      expect(agents[1].parent).toBe('Orchestrator');
      expect(agents[1].cli).toBe('pty'); // pty maps to 'pty'
    });

    it('passes options correctly', async () => {
      mockBrokerClient.listAgents.mockResolvedValue([]);

      await client.listAgents({ include_idle: false, project: 'myproject' });

      // Adapter calls listAgents with no args (broker-sdk doesn't support filtering)
      expect(mockBrokerClient.listAgents).toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('returns connection status', async () => {
      mockBrokerClient.getStatus.mockResolvedValue({ agents: 2, pending: 0 });

      const status = await client.getStatus();

      expect(status.connected).toBe(true);
      expect(status.agentName).toBe('test-agent');
      expect(status.daemonVersion).toBe('broker-sdk');
    });

    it('handles error state by returning disconnected', async () => {
      mockBrokerClient.getStatus.mockRejectedValue(new Error('Connection failed'));

      const status = await client.getStatus();

      expect(status.connected).toBe(false);
      expect(status.agentName).toBe('test-agent');
    });
  });

  describe('queryMessages', () => {
    it('returns empty array (unsupported in broker-sdk)', async () => {
      const result = await client.queryMessages({
        limit: 5,
        from: 'Alice',
        to: 'Bob',
        thread: 'thr-1',
        order: 'asc',
      });

      expect(result).toEqual([]);
    });
  });

  describe('sendLog', () => {
    it('sends log data via sendMessage to #logs channel', async () => {
      await client.sendLog('hello world');

      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: '#logs',
        text: 'hello world',
        from: 'test-agent',
      });
    });
  });

  describe('channels', () => {
    it('joins a channel (unsupported)', async () => {
      const result = await client.joinChannel('#general', 'TestAgent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('leaves a channel (unsupported)', async () => {
      const result = await client.leaveChannel('#general', 'done with project');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not supported');
    });

    it('sends channel message', async () => {
      await client.sendChannelMessage('#team', 'Hello team');

      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: '#team',
        text: 'Hello team',
        from: 'test-agent',
        threadId: undefined,
      });
    });

    it('sends channel message with thread', async () => {
      await client.sendChannelMessage('#team', 'Reply', { thread: 'topic-1' });

      expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
        to: '#team',
        text: 'Reply',
        from: 'test-agent',
        threadId: 'topic-1',
      });
    });
  });

  describe('shadow binding', () => {
    it('binds as shadow', async () => {
      const result = await client.bindAsShadow('PrimaryAgent', { speakOn: ['CODE_WRITTEN'] });

      expect(result.success).toBe(true);
    });

    it('unbinds as shadow', async () => {
      // First bind, then unbind
      await client.bindAsShadow('PrimaryAgent');
      const result = await client.unbindAsShadow('PrimaryAgent');

      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// Multi-Agent Client Scenarios
// ============================================================================

describe('RelayClient multi-agent scenarios', () => {
  let mockBrokerClient: ReturnType<typeof createMockBrokerClient>;
  let client: RelayClient;

  beforeEach(() => {
    mockBrokerClient = createMockBrokerClient();
    mockCreateRelaycastClient.mockResolvedValue(createMockRelaycastAgent() as any);
    client = createRelayClientAdapter(mockBrokerClient as any, {
      agentName: 'orchestrator',
      socketPath: '/tmp/test.sock',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spawns multiple workers from same orchestrator', async () => {
    let spawnCount = 0;
    mockBrokerClient.spawnPty.mockImplementation(async (opts: any) => {
      spawnCount++;
      return { name: opts.name, runtime: 'pty' };
    });

    const results = await Promise.all([
      client.spawn({ name: 'Worker1', cli: 'claude', task: 'Task 1' }),
      client.spawn({ name: 'Worker2', cli: 'claude', task: 'Task 2' }),
      client.spawn({ name: 'Worker3', cli: 'codex', task: 'Task 3' }),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
    expect(mockBrokerClient.spawnPty).toHaveBeenCalledTimes(3);
  });

  it('sends messages to multiple agents', async () => {
    const targets = ['Alice', 'Bob', 'Charlie'];

    await Promise.all(
      targets.map(target => client.send(target, `Hello ${target}`))
    );

    expect(mockBrokerClient.sendMessage).toHaveBeenCalledTimes(3);
    expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
      to: 'Alice', text: 'Hello Alice', from: 'orchestrator', threadId: undefined,
    });
    expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
      to: 'Bob', text: 'Hello Bob', from: 'orchestrator', threadId: undefined,
    });
    expect(mockBrokerClient.sendMessage).toHaveBeenCalledWith({
      to: 'Charlie', text: 'Hello Charlie', from: 'orchestrator', threadId: undefined,
    });
  });

  it('handles inbox with multiple senders', async () => {
    const mockRelaycastAgent = createMockRelaycastAgent();
    mockRelaycastAgent.inbox.mockResolvedValue({
      mentions: [],
      unread_dms: [
        { conversation_id: 'c1', from: 'Alice', unread_count: 1, last_message: 'Hello from Alice' },
        { conversation_id: 'c2', from: 'Bob', unread_count: 1, last_message: 'Hello from Bob' },
        { conversation_id: 'c3', from: 'Charlie', unread_count: 1, last_message: 'Hello from Charlie' },
      ],
      unread_channels: [],
    });
    mockCreateRelaycastClient.mockResolvedValue(mockRelaycastAgent as any);

    // Create a fresh adapter so it uses the new mock
    const freshClient = createRelayClientAdapter(mockBrokerClient as any, {
      agentName: 'orchestrator',
      socketPath: '/tmp/test.sock',
    });

    const inbox = await freshClient.getInbox();

    expect(inbox).toHaveLength(3);
    expect(inbox.map(m => m.from)).toEqual(['Alice', 'Bob', 'Charlie']);
  });
});
