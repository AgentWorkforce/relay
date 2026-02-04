import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRelayClientAdapter, type RelayClient } from '../src/client-adapter.js';

/**
 * Mock SDK RelayClient for testing the adapter layer.
 * The adapter wraps SDK methods and translates between MCP and SDK interfaces.
 */
function createMockSdkClient() {
  return {
    state: 'READY',
    connect: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    // SDK sendMessage signature: (to, message, kind, data, thread)
    sendMessage: vi.fn().mockReturnValue(true),
    sendAndWait: vi.fn().mockResolvedValue({ success: true }),
    // SDK broadcast signature: (message, kind, data)
    broadcast: vi.fn().mockReturnValue(true),
    spawn: vi.fn().mockResolvedValue({ success: true, name: 'Worker', pid: 12345 }),
    // SDK release signature: (name, reason)
    release: vi.fn().mockResolvedValue({ success: true }),
    getInbox: vi.fn().mockResolvedValue([]),
    listAgents: vi.fn().mockResolvedValue([]),
    listConnectedAgents: vi.fn().mockResolvedValue([]),
    getStatus: vi.fn().mockResolvedValue({ version: '1.0.0', uptime: 3600000 }),
    getHealth: vi.fn().mockResolvedValue({ healthy: true }),
    getMetrics: vi.fn().mockResolvedValue({ agents: [] }),
    queryMessages: vi.fn().mockResolvedValue([]),
    sendLog: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(true),
    unsubscribe: vi.fn().mockReturnValue(true),
    joinChannel: vi.fn().mockReturnValue(true),
    leaveChannel: vi.fn().mockReturnValue(true),
    // SDK sendChannelMessage signature: (channel, message, options)
    sendChannelMessage: vi.fn().mockReturnValue(true),
    adminJoinChannel: vi.fn().mockReturnValue(true),
    adminRemoveMember: vi.fn().mockReturnValue(true),
    // SDK bindAsShadow signature: (primaryAgent, options)
    bindAsShadow: vi.fn().mockReturnValue(true),
    unbindAsShadow: vi.fn().mockReturnValue(true),
    createProposal: vi.fn().mockReturnValue(true),
    vote: vi.fn().mockReturnValue(true),
    removeAgent: vi.fn().mockResolvedValue({ success: true, removed: true }),
    // Event emitter methods
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  };
}

describe('RelayClient Adapter', () => {
  let mockSdkClient: ReturnType<typeof createMockSdkClient>;
  let client: RelayClient;

  beforeEach(() => {
    mockSdkClient = createMockSdkClient();
    client = createRelayClientAdapter(mockSdkClient as any, {
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

      // SDK signature: sendMessage(to, message, kind, data, thread)
      expect(mockSdkClient.sendMessage).toHaveBeenCalledWith('Alice', 'Hello', 'message', undefined, undefined);
    });

    it('sends a message with thread', async () => {
      await client.send('Worker', 'Continue', { thread: 'task-123' });

      expect(mockSdkClient.sendMessage).toHaveBeenCalledWith('Worker', 'Continue', 'message', undefined, 'task-123');
    });

    it('sends a message with custom kind and data', async () => {
      await client.send('Bob', 'Status update', { kind: 'status', data: { progress: 50 } });

      expect(mockSdkClient.sendMessage).toHaveBeenCalledWith('Bob', 'Status update', 'status', { progress: 50 }, undefined);
    });
  });

  describe('broadcast', () => {
    it('broadcasts to all agents', async () => {
      await client.broadcast('Hello everyone');

      // SDK signature: broadcast(message, kind, data)
      expect(mockSdkClient.broadcast).toHaveBeenCalledWith('Hello everyone', 'message', undefined);
    });

    it('broadcasts with custom kind', async () => {
      await client.broadcast('System notice', { kind: 'alert' });

      expect(mockSdkClient.broadcast).toHaveBeenCalledWith('System notice', 'alert', undefined);
    });
  });

  describe('spawn', () => {
    it('spawns a worker with basic options', async () => {
      mockSdkClient.spawn.mockResolvedValue({ success: true, name: 'Worker1', pid: 12345 });

      const result = await client.spawn({
        name: 'Worker1',
        cli: 'claude',
        task: 'Test task',
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe('Worker1');
      expect(result.pid).toBe(12345);
      expect(mockSdkClient.spawn).toHaveBeenCalledWith({
        name: 'Worker1',
        cli: 'claude',
        task: 'Test task',
      });
    });

    it('spawns a worker with all options', async () => {
      mockSdkClient.spawn.mockResolvedValue({ success: true, name: 'TestWorker', pid: 54321 });

      const result = await client.spawn({
        name: 'TestWorker',
        cli: 'codex',
        task: 'Complex task',
        model: 'gpt-4',
        cwd: '/tmp/project',
      });

      expect(result.success).toBe(true);
      expect(mockSdkClient.spawn).toHaveBeenCalledWith({
        name: 'TestWorker',
        cli: 'codex',
        task: 'Complex task',
        model: 'gpt-4',
        cwd: '/tmp/project',
      });
    });

    it('handles spawn failure', async () => {
      mockSdkClient.spawn.mockResolvedValue({ success: false, name: 'FailWorker', error: 'Out of resources' });

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
      mockSdkClient.release.mockResolvedValue({ success: true });

      const result = await client.release('Worker1');

      expect(result.success).toBe(true);
      // SDK signature: release(name, reason)
      expect(mockSdkClient.release).toHaveBeenCalledWith('Worker1', undefined);
    });

    it('releases a worker with reason', async () => {
      mockSdkClient.release.mockResolvedValue({ success: true });

      const result = await client.release('Worker1', 'task completed');

      expect(result.success).toBe(true);
      expect(mockSdkClient.release).toHaveBeenCalledWith('Worker1', 'task completed');
    });

    it('handles release failure', async () => {
      mockSdkClient.release.mockResolvedValue({ success: false, error: 'Agent not found' });

      const result = await client.release('NonExistent');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
    });
  });

  describe('getInbox', () => {
    it('returns empty inbox', async () => {
      mockSdkClient.getInbox.mockResolvedValue([]);

      const inbox = await client.getInbox();

      expect(inbox).toEqual([]);
      expect(mockSdkClient.getInbox).toHaveBeenCalled();
    });

    it('maps inbox messages correctly', async () => {
      mockSdkClient.getInbox.mockResolvedValue([
        { id: '1', from: 'Alice', body: 'Hi there', channel: '#team', thread: 'thr-1' },
        { id: '2', from: 'Bob', body: 'Hello' },
      ]);

      const inbox = await client.getInbox();

      expect(inbox).toHaveLength(2);
      expect(inbox[0]).toEqual({
        id: '1',
        from: 'Alice',
        content: 'Hi there',
        channel: '#team',
        thread: 'thr-1',
      });
      expect(inbox[1]).toEqual({
        id: '2',
        from: 'Bob',
        content: 'Hello',
        channel: undefined,
        thread: undefined,
      });
    });

    it('passes filter options', async () => {
      mockSdkClient.getInbox.mockResolvedValue([]);

      await client.getInbox({ limit: 10, unread_only: true, from: 'Alice' });

      expect(mockSdkClient.getInbox).toHaveBeenCalledWith({
        limit: 10,
        unreadOnly: true,
        from: 'Alice',
        channel: undefined,
      });
    });
  });

  describe('listAgents', () => {
    it('returns list of agents', async () => {
      const mockAgents = [
        { name: 'Orchestrator', cli: 'sdk', idle: false },
        { name: 'Worker1', cli: 'claude', idle: false, parent: 'Orchestrator' },
        { name: 'Worker2', cli: 'claude', idle: true, parent: 'Orchestrator' },
      ];
      mockSdkClient.listAgents.mockResolvedValue(mockAgents);

      const agents = await client.listAgents({ include_idle: true });

      expect(agents).toHaveLength(3);
      expect(agents[0].name).toBe('Orchestrator');
      expect(agents[1].parent).toBe('Orchestrator');
      expect(agents[2].idle).toBe(true);
    });

    it('passes options correctly', async () => {
      mockSdkClient.listAgents.mockResolvedValue([]);

      await client.listAgents({ include_idle: false, project: 'myproject' });

      expect(mockSdkClient.listAgents).toHaveBeenCalledWith({
        includeIdle: false,
        project: 'myproject',
      });
    });
  });

  describe('getStatus', () => {
    it('returns connection status', async () => {
      mockSdkClient.getStatus.mockResolvedValue({ version: '2.0.0', uptime: 7200000 });
      mockSdkClient.state = 'READY';

      const status = await client.getStatus();

      expect(status.connected).toBe(true);
      expect(status.agentName).toBe('test-agent');
      expect(status.daemonVersion).toBe('2.0.0');
      expect(status.uptime).toBe('7200s');
    });

    it('handles error state by returning disconnected', async () => {
      // The adapter catches errors from getStatus and returns disconnected status
      // Need to make getStatus throw (not connect) since ensureReady won't call connect if state is READY
      mockSdkClient.getStatus.mockRejectedValue(new Error('Connection failed'));

      const status = await client.getStatus();

      expect(status.connected).toBe(false);
      expect(status.agentName).toBe('test-agent');
    });
  });

  describe('queryMessages', () => {
    it('returns queried messages', async () => {
      const mockMessages = [
        {
          id: 'm1',
          from: 'Alice',
          to: 'Bob',
          body: 'Hi',
          channel: '#team',
          thread: 'thr-1',
          timestamp: 1700000000000,
        },
      ];
      mockSdkClient.queryMessages.mockResolvedValue(mockMessages);

      const result = await client.queryMessages({
        limit: 5,
        from: 'Alice',
        to: 'Bob',
        thread: 'thr-1',
        order: 'asc',
      });

      expect(result).toEqual(mockMessages);
      expect(mockSdkClient.queryMessages).toHaveBeenCalledWith({
        limit: 5,
        from: 'Alice',
        to: 'Bob',
        thread: 'thr-1',
        order: 'asc',
      });
    });
  });

  describe('sendLog', () => {
    it('sends log data', async () => {
      await client.sendLog('hello world');

      expect(mockSdkClient.sendLog).toHaveBeenCalledWith('hello world');
    });
  });

  describe('channels', () => {
    it('joins a channel', async () => {
      mockSdkClient.joinChannel.mockReturnValue(true);

      const result = await client.joinChannel('#general', 'TestAgent');

      expect(result.success).toBe(true);
      expect(mockSdkClient.joinChannel).toHaveBeenCalledWith('#general', 'TestAgent');
    });

    it('leaves a channel', async () => {
      mockSdkClient.leaveChannel.mockReturnValue(true);

      const result = await client.leaveChannel('#general', 'done with project');

      expect(result.success).toBe(true);
      expect(mockSdkClient.leaveChannel).toHaveBeenCalledWith('#general', 'done with project');
    });

    it('sends channel message', async () => {
      await client.sendChannelMessage('#team', 'Hello team');

      // SDK signature: sendChannelMessage(channel, message, { thread })
      expect(mockSdkClient.sendChannelMessage).toHaveBeenCalledWith('#team', 'Hello team', { thread: undefined });
    });

    it('sends channel message with thread', async () => {
      await client.sendChannelMessage('#team', 'Reply', { thread: 'topic-1' });

      expect(mockSdkClient.sendChannelMessage).toHaveBeenCalledWith('#team', 'Reply', { thread: 'topic-1' });
    });
  });

  describe('shadow binding', () => {
    it('binds as shadow', async () => {
      mockSdkClient.bindAsShadow.mockReturnValue(true);

      const result = await client.bindAsShadow('PrimaryAgent', { speakOn: ['CODE_WRITTEN'] });

      expect(result.success).toBe(true);
      expect(mockSdkClient.bindAsShadow).toHaveBeenCalledWith('PrimaryAgent', { speakOn: ['CODE_WRITTEN'] });
    });

    it('unbinds as shadow', async () => {
      mockSdkClient.unbindAsShadow.mockReturnValue(true);

      const result = await client.unbindAsShadow('PrimaryAgent');

      expect(result.success).toBe(true);
      expect(mockSdkClient.unbindAsShadow).toHaveBeenCalledWith('PrimaryAgent');
    });
  });
});

// ============================================================================
// Multi-Agent Client Scenarios
// ============================================================================

describe('RelayClient multi-agent scenarios', () => {
  let mockSdkClient: ReturnType<typeof createMockSdkClient>;
  let client: RelayClient;

  beforeEach(() => {
    mockSdkClient = createMockSdkClient();
    client = createRelayClientAdapter(mockSdkClient as any, {
      agentName: 'orchestrator',
      socketPath: '/tmp/test.sock',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spawns multiple workers from same orchestrator', async () => {
    let spawnCount = 0;
    mockSdkClient.spawn.mockImplementation(async (opts: any) => {
      spawnCount++;
      return { success: true, name: opts.name, pid: 10000 + spawnCount };
    });

    const results = await Promise.all([
      client.spawn({ name: 'Worker1', cli: 'claude', task: 'Task 1' }),
      client.spawn({ name: 'Worker2', cli: 'claude', task: 'Task 2' }),
      client.spawn({ name: 'Worker3', cli: 'codex', task: 'Task 3' }),
    ]);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
    expect(mockSdkClient.spawn).toHaveBeenCalledTimes(3);
  });

  it('sends messages to multiple agents', async () => {
    const targets = ['Alice', 'Bob', 'Charlie'];

    await Promise.all(
      targets.map(target => client.send(target, `Hello ${target}`))
    );

    expect(mockSdkClient.sendMessage).toHaveBeenCalledTimes(3);
    // SDK signature: sendMessage(to, message, kind, data, thread)
    expect(mockSdkClient.sendMessage).toHaveBeenCalledWith('Alice', 'Hello Alice', 'message', undefined, undefined);
    expect(mockSdkClient.sendMessage).toHaveBeenCalledWith('Bob', 'Hello Bob', 'message', undefined, undefined);
    expect(mockSdkClient.sendMessage).toHaveBeenCalledWith('Charlie', 'Hello Charlie', 'message', undefined, undefined);
  });

  it('handles inbox with multiple senders', async () => {
    mockSdkClient.getInbox.mockResolvedValue([
      { id: '1', from: 'Alice', body: 'Hello from Alice' },
      { id: '2', from: 'Bob', body: 'Hello from Bob' },
      { id: '3', from: 'Charlie', body: 'Hello from Charlie' },
    ]);

    const inbox = await client.getInbox();

    expect(inbox).toHaveLength(3);
    expect(inbox.map(m => m.from)).toEqual(['Alice', 'Bob', 'Charlie']);
  });
});
