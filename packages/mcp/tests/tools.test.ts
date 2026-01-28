import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayClient } from '../src/client.js';
import {
  handleRelaySend,
  relaySendSchema,
  handleRelayInbox,
  relayInboxSchema,
  handleRelayWho,
  relayWhoSchema,
  handleRelaySpawn,
  handleRelayRelease,
  handleRelayStatus,
  handleRelayBroadcast,
  relayBroadcastSchema,
  handleRelaySubscribe,
  relaySubscribeSchema,
  handleRelayUnsubscribe,
  relayUnsubscribeSchema,
  handleRelayChannelJoin,
  relayChannelJoinSchema,
  handleRelayChannelLeave,
  relayChannelLeaveSchema,
  handleRelayChannelMessage,
  relayChannelMessageSchema,
  handleRelayShadowBind,
  relayShadowBindSchema,
  handleRelayShadowUnbind,
  relayShadowUnbindSchema,
  handleRelayProposal,
  relayProposalSchema,
  handleRelayVote,
  relayVoteSchema,
} from '../src/tools/index.js';

/**
 * Creates a mock RelayClient with all methods stubbed.
 * Only specify the methods you need for each test.
 */
function createMockClient(overrides: Partial<Record<keyof RelayClient, ReturnType<typeof vi.fn>>> = {}): RelayClient {
  return {
    send: vi.fn(),
    sendAndWait: vi.fn(),
    spawn: vi.fn(),
    release: vi.fn(),
    getStatus: vi.fn(),
    getInbox: vi.fn(),
    listAgents: vi.fn(),
    broadcast: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    sendChannelMessage: vi.fn(),
    bindAsShadow: vi.fn(),
    unbindAsShadow: vi.fn(),
    createProposal: vi.fn(),
    vote: vi.fn(),
    ...overrides,
  };
}

describe('relay_send', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('sends a direct message', async () => {
    vi.mocked(mockClient.send).mockResolvedValue(undefined);

    const input = relaySendSchema.parse({
      to: 'Alice',
      message: 'Hello',
    });
    const result = await handleRelaySend(mockClient, input);

    expect(result).toBe('Message sent to Alice');
    expect(mockClient.send).toHaveBeenCalledWith('Alice', 'Hello', { thread: undefined });
  });

  it('sends to a channel', async () => {
    vi.mocked(mockClient.send).mockResolvedValue(undefined);

    const input = relaySendSchema.parse({
      to: '#general',
      message: 'Team update',
    });
    const result = await handleRelaySend(mockClient, input);

    expect(result).toBe('Message sent to #general');
    expect(mockClient.send).toHaveBeenCalledWith('#general', 'Team update', { thread: undefined });
  });

  it('awaits response when requested', async () => {
    vi.mocked(mockClient.sendAndWait).mockResolvedValue({
      ack_id: 'msg-123',
      seq: 1,
      correlationId: 'corr-456',
      response: 'Done!',
      responseData: undefined,
    });

    const result = await handleRelaySend(mockClient, {
      to: 'Worker',
      message: 'Process this',
      await_response: true,
      timeout_ms: 5000,
      thread: 'task-123',
    });

    expect(result).toBe('Response from Worker: Done!');
    expect(mockClient.sendAndWait).toHaveBeenCalledWith('Worker', 'Process this', {
      thread: 'task-123',
      timeoutMs: 5000,
    });
  });
});

describe('relay_inbox', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('returns no messages message when inbox empty', async () => {
    vi.mocked(mockClient.getInbox).mockResolvedValue([]);

    const input = relayInboxSchema.parse({});
    const result = await handleRelayInbox(mockClient, input);

    expect(result).toBe('No messages in inbox.');
    // After parsing, limit and unread_only have defaults
    expect(mockClient.getInbox).toHaveBeenCalledWith({ limit: 10, unread_only: true });
  });

  it('formats messages with channel and thread', async () => {
    vi.mocked(mockClient.getInbox).mockResolvedValue([
      {
        id: '123',
        from: 'Lead',
        content: 'Update',
        channel: '#general',
        thread: 'thr-1',
      },
      {
        id: '124',
        from: 'Worker',
        content: 'Done',
      },
    ]);

    const input = relayInboxSchema.parse({
      limit: 5,
      unread_only: true,
      from: 'Lead',
    });
    const result = await handleRelayInbox(mockClient, input);

    expect(mockClient.getInbox).toHaveBeenCalledWith({
      limit: 5,
      unread_only: true,
      from: 'Lead',
    });
    expect(result).toContain('2 message(s):');
    expect(result).toContain('[123] From Lead [#general] (thread: thr-1):\nUpdate');
    expect(result).toContain('[124] From Worker:\nDone');
  });
});

describe('relay_who', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('returns message when no agents online', async () => {
    vi.mocked(mockClient.listAgents).mockResolvedValue([]);

    const input = relayWhoSchema.parse({});
    const result = await handleRelayWho(mockClient, input);

    expect(result).toBe('No agents online.');
    // After parsing, include_idle has a default of true
    expect(mockClient.listAgents).toHaveBeenCalledWith({ include_idle: true });
  });

  it('lists agents with status and parent info', async () => {
    vi.mocked(mockClient.listAgents).mockResolvedValue([
      { name: 'Alice', cli: 'claude', idle: false },
      { name: 'Bob', cli: 'codex', idle: true },
      { name: 'Worker1', cli: 'claude', idle: false, parent: 'Alice' },
    ]);

    const input = relayWhoSchema.parse({ include_idle: true, project: 'proj' });
    const result = await handleRelayWho(mockClient, input);

    expect(mockClient.listAgents).toHaveBeenCalledWith({ include_idle: true, project: 'proj' });
    expect(result).toContain('3 agent(s) online:');
    expect(result).toContain('- Alice (claude) - active');
    expect(result).toContain('- Bob (codex) - idle');
    expect(result).toContain('- Worker1 (claude) - active [worker of: Alice]');
  });
});

describe('relay_spawn', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('returns success message when worker spawns', async () => {
    vi.mocked(mockClient.spawn).mockResolvedValue({ success: true });

    const result = await handleRelaySpawn(mockClient, {
      name: 'TestRunner',
      cli: 'claude',
      task: 'Run tests',
      model: 'claude-3',
      cwd: '/tmp',
    });

    expect(result).toContain('spawned successfully');
    expect(mockClient.spawn).toHaveBeenCalledWith({
      name: 'TestRunner',
      cli: 'claude',
      task: 'Run tests',
      model: 'claude-3',
      cwd: '/tmp',
    });
  });

  it('returns failure message when spawn fails', async () => {
    vi.mocked(mockClient.spawn).mockResolvedValue({ success: false, error: 'Busy' });

    const result = await handleRelaySpawn(mockClient, {
      name: 'Worker',
      cli: 'codex',
      task: 'Do thing',
    });

    expect(result).toContain('Failed to spawn worker');
    expect(result).toContain('Busy');
  });
});

describe('relay_release', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('returns success message when worker released', async () => {
    vi.mocked(mockClient.release).mockResolvedValue({ success: true });

    const result = await handleRelayRelease(mockClient, {
      name: 'Worker1',
      reason: 'done',
    });

    expect(result).toBe('Worker "Worker1" released.');
    expect(mockClient.release).toHaveBeenCalledWith('Worker1', 'done');
  });

  it('returns failure message when release fails', async () => {
    vi.mocked(mockClient.release).mockResolvedValue({ success: false, error: 'not found' });

    const result = await handleRelayRelease(mockClient, {
      name: 'Worker2',
    });

    expect(result).toBe('Failed to release worker: not found');
  });
});

describe('relay_status', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('formats status output', async () => {
    vi.mocked(mockClient.getStatus).mockResolvedValue({
      connected: true,
      agentName: 'AgentA',
      project: 'proj',
      socketPath: '/tmp/socket',
      daemonVersion: '0.1.0',
      uptime: '1h',
    });

    const result = await handleRelayStatus(mockClient, {});

    expect(result).toContain('Connected: Yes');
    expect(result).toContain('Agent Name: AgentA');
    expect(result).toContain('Project: proj');
    expect(result).toContain('Socket: /tmp/socket');
    expect(result).toContain('Daemon Version: 0.1.0');
    expect(result).toContain('Uptime: 1h');
  });

  it('handles disconnected status', async () => {
    vi.mocked(mockClient.getStatus).mockResolvedValue({
      connected: false,
      agentName: 'AgentA',
      project: 'proj',
      socketPath: '/tmp/socket',
    });

    const result = await handleRelayStatus(mockClient, {});

    expect(result).toContain('Connected: No');
  });
});

// ============================================================================
// Multi-Agent Scenarios (SDK parity tests)
// ============================================================================

describe('multi-agent scenarios', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('spawns multiple workers sequentially', async () => {
    vi.mocked(mockClient.spawn).mockResolvedValue({ success: true });

    // Spawn Worker1
    const result1 = await handleRelaySpawn(mockClient, {
      name: 'Worker1',
      cli: 'claude',
      task: 'Task 1',
    });
    expect(result1).toContain('spawned successfully');

    // Spawn Worker2
    const result2 = await handleRelaySpawn(mockClient, {
      name: 'Worker2',
      cli: 'claude',
      task: 'Task 2',
    });
    expect(result2).toContain('spawned successfully');

    // Spawn Worker3
    const result3 = await handleRelaySpawn(mockClient, {
      name: 'Worker3',
      cli: 'claude',
      task: 'Task 3',
    });
    expect(result3).toContain('spawned successfully');

    expect(mockClient.spawn).toHaveBeenCalledTimes(3);
  });

  it('lists multiple agents with different statuses', async () => {
    vi.mocked(mockClient.listAgents).mockResolvedValue([
      { name: 'Orchestrator', cli: 'sdk', idle: false },
      { name: 'Worker1', cli: 'claude', idle: false, parent: 'Orchestrator' },
      { name: 'Worker2', cli: 'claude', idle: true, parent: 'Orchestrator' },
      { name: 'Worker3', cli: 'codex', idle: false, parent: 'Orchestrator' },
    ]);

    const input = relayWhoSchema.parse({ include_idle: true });
    const result = await handleRelayWho(mockClient, input);

    expect(result).toContain('4 agent(s) online:');
    expect(result).toContain('Orchestrator');
    expect(result).toContain('Worker1');
    expect(result).toContain('Worker2');
    expect(result).toContain('Worker3');
  });

  it('releases multiple workers', async () => {
    vi.mocked(mockClient.release)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'already exited' });

    const result1 = await handleRelayRelease(mockClient, { name: 'Worker1' });
    expect(result1).toBe('Worker "Worker1" released.');

    const result2 = await handleRelayRelease(mockClient, { name: 'Worker2' });
    expect(result2).toBe('Worker "Worker2" released.');

    const result3 = await handleRelayRelease(mockClient, { name: 'Worker3' });
    expect(result3).toBe('Failed to release worker: already exited');

    expect(mockClient.release).toHaveBeenCalledTimes(3);
  });

  it('handles release of non-existent agent gracefully', async () => {
    vi.mocked(mockClient.release).mockResolvedValue({
      success: false,
      error: 'Agent not found: NonExistentAgent',
    });

    const result = await handleRelayRelease(mockClient, {
      name: 'NonExistentAgent',
    });

    expect(result).toBe('Failed to release worker: Agent not found: NonExistentAgent');
  });
});

// ============================================================================
// Message Threading Scenarios
// ============================================================================

describe('message threading', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('sends message with thread ID', async () => {
    vi.mocked(mockClient.send).mockResolvedValue(undefined);

    const input = relaySendSchema.parse({
      to: 'Worker',
      message: 'Continue task',
      thread: 'task-thread-123',
    });
    await handleRelaySend(mockClient, input);

    expect(mockClient.send).toHaveBeenCalledWith('Worker', 'Continue task', {
      thread: 'task-thread-123',
    });
  });

  it('filters inbox by thread', async () => {
    vi.mocked(mockClient.getInbox).mockResolvedValue([
      { id: '1', from: 'Worker', content: 'Done step 1', thread: 'task-123' },
      { id: '2', from: 'Worker', content: 'Done step 2', thread: 'task-123' },
    ]);

    const input = relayInboxSchema.parse({ limit: 10 });
    const result = await handleRelayInbox(mockClient, input);

    expect(result).toContain('2 message(s):');
    expect(result).toContain('(thread: task-123)');
  });
});

// ============================================================================
// Broadcast-like Scenarios (send to multiple agents)
// ============================================================================

describe('broadcast scenarios', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('sends messages to multiple agents', async () => {
    vi.mocked(mockClient.send).mockResolvedValue(undefined);
    const agents = ['Alice', 'Bob', 'Charlie'];

    for (const agent of agents) {
      const input = relaySendSchema.parse({
        to: agent,
        message: 'Broadcast message to all',
      });
      await handleRelaySend(mockClient, input);
    }

    expect(mockClient.send).toHaveBeenCalledTimes(3);
    expect(mockClient.send).toHaveBeenCalledWith('Alice', 'Broadcast message to all', { thread: undefined });
    expect(mockClient.send).toHaveBeenCalledWith('Bob', 'Broadcast message to all', { thread: undefined });
    expect(mockClient.send).toHaveBeenCalledWith('Charlie', 'Broadcast message to all', { thread: undefined });
  });

  it('receives messages from multiple senders', async () => {
    vi.mocked(mockClient.getInbox).mockResolvedValue([
      { id: '1', from: 'Alice', content: 'Hello from Alice' },
      { id: '2', from: 'Bob', content: 'Hello from Bob' },
      { id: '3', from: 'Charlie', content: 'Hello from Charlie' },
    ]);

    const input = relayInboxSchema.parse({ limit: 10 });
    const result = await handleRelayInbox(mockClient, input);

    expect(result).toContain('3 message(s):');
    expect(result).toContain('From Alice');
    expect(result).toContain('From Bob');
    expect(result).toContain('From Charlie');
  });
});

// ============================================================================
// Negotiation-like Workflow Scenarios
// ============================================================================

describe('negotiation workflow', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('coordinates multi-round communication', async () => {
    vi.mocked(mockClient.spawn).mockResolvedValue({ success: true });
    vi.mocked(mockClient.send).mockResolvedValue(undefined);
    vi.mocked(mockClient.sendAndWait)
      .mockResolvedValueOnce({ from: 'Frontend', content: 'Frontend priorities: Design System, Accessibility' })
      .mockResolvedValueOnce({ from: 'Backend', content: 'Backend priorities: Microservices, Caching' })
      .mockResolvedValueOnce({ from: 'Infra', content: 'Infra priorities: Kubernetes, Multi-Region' });

    // Spawn agents
    const teams = ['Frontend', 'Backend', 'Infra'];
    for (const team of teams) {
      await handleRelaySpawn(mockClient, {
        name: team,
        cli: 'claude',
        task: `You are the ${team} team lead`,
      });
    }
    expect(mockClient.spawn).toHaveBeenCalledTimes(3);

    // Request introductions (with await_response)
    for (const team of teams) {
      await handleRelaySend(mockClient, {
        to: team,
        message: 'Please introduce yourself',
        await_response: true,
        timeout_ms: 30000,
      });
    }
    expect(mockClient.sendAndWait).toHaveBeenCalledTimes(3);
  });

  it('handles voting responses', async () => {
    vi.mocked(mockClient.getInbox).mockResolvedValue([
      { id: '1', from: 'Frontend', content: 'I VOTE: Frontend=$35000, Backend=$35000, Infra=$30000' },
      { id: '2', from: 'Backend', content: 'I VOTE: Frontend=$30000, Backend=$40000, Infra=$30000' },
      { id: '3', from: 'Infra', content: 'I VOTE: Frontend=$33000, Backend=$35000, Infra=$32000' },
    ]);

    const input = relayInboxSchema.parse({ limit: 10 });
    const result = await handleRelayInbox(mockClient, input);

    expect(result).toContain('3 message(s):');
    expect(result).toContain('I VOTE:');
    expect(result).toContain('Frontend');
    expect(result).toContain('Backend');
    expect(result).toContain('Infra');
  });
});

// ============================================================================
// Broadcast Tool Tests
// ============================================================================

describe('relay_broadcast', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('broadcasts a message to all agents', async () => {
    vi.mocked(mockClient.broadcast).mockResolvedValue(undefined);

    const input = relayBroadcastSchema.parse({
      message: 'Hello everyone!',
    });
    const result = await handleRelayBroadcast(mockClient, input);

    expect(result).toBe('Message broadcast to all agents');
    expect(mockClient.broadcast).toHaveBeenCalledWith('Hello everyone!', { kind: undefined });
  });

  it('broadcasts with message kind', async () => {
    vi.mocked(mockClient.broadcast).mockResolvedValue(undefined);

    const input = relayBroadcastSchema.parse({
      message: 'System update',
      kind: 'action',
    });
    const result = await handleRelayBroadcast(mockClient, input);

    expect(result).toBe('Message broadcast to all agents');
    expect(mockClient.broadcast).toHaveBeenCalledWith('System update', { kind: 'action' });
  });

  it('supports different message kinds', async () => {
    vi.mocked(mockClient.broadcast).mockResolvedValue(undefined);

    const kinds = ['message', 'action', 'state', 'thinking'] as const;
    for (const kind of kinds) {
      const input = relayBroadcastSchema.parse({
        message: `Test ${kind}`,
        kind,
      });
      await handleRelayBroadcast(mockClient, input);
    }

    expect(mockClient.broadcast).toHaveBeenCalledTimes(4);
  });
});

// ============================================================================
// Subscribe/Unsubscribe Tool Tests
// ============================================================================

describe('relay_subscribe', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('subscribes to a topic', async () => {
    vi.mocked(mockClient.subscribe).mockResolvedValue({ success: true });

    const input = relaySubscribeSchema.parse({
      topic: 'updates',
    });
    const result = await handleRelaySubscribe(mockClient, input);

    expect(result).toBe('Subscribed to topic "updates"');
    expect(mockClient.subscribe).toHaveBeenCalledWith('updates');
  });

  it('returns error when subscription fails', async () => {
    vi.mocked(mockClient.subscribe).mockResolvedValue({
      success: false,
      error: 'Topic does not exist',
    });

    const input = relaySubscribeSchema.parse({
      topic: 'nonexistent',
    });
    const result = await handleRelaySubscribe(mockClient, input);

    expect(result).toBe('Failed to subscribe: Topic does not exist');
  });
});

describe('relay_unsubscribe', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('unsubscribes from a topic', async () => {
    vi.mocked(mockClient.unsubscribe).mockResolvedValue({ success: true });

    const input = relayUnsubscribeSchema.parse({
      topic: 'updates',
    });
    const result = await handleRelayUnsubscribe(mockClient, input);

    expect(result).toBe('Unsubscribed from topic "updates"');
    expect(mockClient.unsubscribe).toHaveBeenCalledWith('updates');
  });

  it('returns error when unsubscribe fails', async () => {
    vi.mocked(mockClient.unsubscribe).mockResolvedValue({
      success: false,
      error: 'Not subscribed to topic',
    });

    const input = relayUnsubscribeSchema.parse({
      topic: 'random',
    });
    const result = await handleRelayUnsubscribe(mockClient, input);

    expect(result).toBe('Failed to unsubscribe: Not subscribed to topic');
  });
});

// ============================================================================
// Channel Tool Tests
// ============================================================================

describe('relay_channel_join', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('joins a channel', async () => {
    vi.mocked(mockClient.joinChannel).mockResolvedValue({ success: true });

    const input = relayChannelJoinSchema.parse({
      channel: '#general',
    });
    const result = await handleRelayChannelJoin(mockClient, input);

    expect(result).toBe('Joined channel "#general"');
    expect(mockClient.joinChannel).toHaveBeenCalledWith('#general', undefined);
  });

  it('joins a channel with display name', async () => {
    vi.mocked(mockClient.joinChannel).mockResolvedValue({ success: true });

    const input = relayChannelJoinSchema.parse({
      channel: '#dev-team',
      display_name: 'Alice (Lead)',
    });
    const result = await handleRelayChannelJoin(mockClient, input);

    expect(result).toBe('Joined channel "#dev-team"');
    expect(mockClient.joinChannel).toHaveBeenCalledWith('#dev-team', 'Alice (Lead)');
  });

  it('returns error when join fails', async () => {
    vi.mocked(mockClient.joinChannel).mockResolvedValue({
      success: false,
      error: 'Channel is private',
    });

    const input = relayChannelJoinSchema.parse({
      channel: '#secret',
    });
    const result = await handleRelayChannelJoin(mockClient, input);

    expect(result).toBe('Failed to join channel: Channel is private');
  });
});

describe('relay_channel_leave', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('leaves a channel', async () => {
    vi.mocked(mockClient.leaveChannel).mockResolvedValue({ success: true });

    const input = relayChannelLeaveSchema.parse({
      channel: '#general',
    });
    const result = await handleRelayChannelLeave(mockClient, input);

    expect(result).toBe('Left channel "#general"');
    expect(mockClient.leaveChannel).toHaveBeenCalledWith('#general', undefined);
  });

  it('leaves a channel with reason', async () => {
    vi.mocked(mockClient.leaveChannel).mockResolvedValue({ success: true });

    const input = relayChannelLeaveSchema.parse({
      channel: '#dev-team',
      reason: 'Task completed',
    });
    const result = await handleRelayChannelLeave(mockClient, input);

    expect(result).toBe('Left channel "#dev-team"');
    expect(mockClient.leaveChannel).toHaveBeenCalledWith('#dev-team', 'Task completed');
  });

  it('returns error when leave fails', async () => {
    vi.mocked(mockClient.leaveChannel).mockResolvedValue({
      success: false,
      error: 'Not a member of channel',
    });

    const input = relayChannelLeaveSchema.parse({
      channel: '#random',
    });
    const result = await handleRelayChannelLeave(mockClient, input);

    expect(result).toBe('Failed to leave channel: Not a member of channel');
  });
});

describe('relay_channel_message', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('sends a message to a channel', async () => {
    vi.mocked(mockClient.sendChannelMessage).mockResolvedValue(undefined);

    const input = relayChannelMessageSchema.parse({
      channel: '#general',
      message: 'Hello channel!',
    });
    const result = await handleRelayChannelMessage(mockClient, input);

    expect(result).toBe('Message sent to channel "#general"');
    expect(mockClient.sendChannelMessage).toHaveBeenCalledWith('#general', 'Hello channel!', { thread: undefined });
  });

  it('sends a threaded message to a channel', async () => {
    vi.mocked(mockClient.sendChannelMessage).mockResolvedValue(undefined);

    const input = relayChannelMessageSchema.parse({
      channel: '#dev-team',
      message: 'Follow-up on this',
      thread: 'thread-123',
    });
    const result = await handleRelayChannelMessage(mockClient, input);

    expect(result).toBe('Message sent to channel "#dev-team"');
    expect(mockClient.sendChannelMessage).toHaveBeenCalledWith('#dev-team', 'Follow-up on this', { thread: 'thread-123' });
  });
});

// ============================================================================
// Shadow Agent Tool Tests
// ============================================================================

describe('relay_shadow_bind', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('binds as a shadow agent', async () => {
    vi.mocked(mockClient.bindAsShadow).mockResolvedValue({ success: true });

    const input = relayShadowBindSchema.parse({
      primary_agent: 'Alice',
    });
    const result = await handleRelayShadowBind(mockClient, input);

    expect(result).toBe('Now shadowing agent "Alice"');
    expect(mockClient.bindAsShadow).toHaveBeenCalledWith('Alice', { speakOn: undefined });
  });

  it('binds with speak_on events', async () => {
    vi.mocked(mockClient.bindAsShadow).mockResolvedValue({ success: true });

    const input = relayShadowBindSchema.parse({
      primary_agent: 'Alice',
      speak_on: ['SESSION_END', 'CODE_WRITTEN'],
    });
    const result = await handleRelayShadowBind(mockClient, input);

    expect(result).toBe('Now shadowing agent "Alice"');
    expect(mockClient.bindAsShadow).toHaveBeenCalledWith('Alice', {
      speakOn: ['SESSION_END', 'CODE_WRITTEN'],
    });
  });

  it('returns error when bind fails', async () => {
    vi.mocked(mockClient.bindAsShadow).mockResolvedValue({
      success: false,
      error: 'Agent not found',
    });

    const input = relayShadowBindSchema.parse({
      primary_agent: 'Unknown',
    });
    const result = await handleRelayShadowBind(mockClient, input);

    expect(result).toBe('Failed to bind as shadow: Agent not found');
  });
});

describe('relay_shadow_unbind', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('unbinds from shadowing', async () => {
    vi.mocked(mockClient.unbindAsShadow).mockResolvedValue({ success: true });

    const input = relayShadowUnbindSchema.parse({
      primary_agent: 'Alice',
    });
    const result = await handleRelayShadowUnbind(mockClient, input);

    expect(result).toBe('Stopped shadowing agent "Alice"');
    expect(mockClient.unbindAsShadow).toHaveBeenCalledWith('Alice');
  });

  it('returns error when unbind fails', async () => {
    vi.mocked(mockClient.unbindAsShadow).mockResolvedValue({
      success: false,
      error: 'Not shadowing this agent',
    });

    const input = relayShadowUnbindSchema.parse({
      primary_agent: 'Bob',
    });
    const result = await handleRelayShadowUnbind(mockClient, input);

    expect(result).toBe('Failed to unbind from shadow: Not shadowing this agent');
  });
});

// ============================================================================
// Consensus/Voting Tool Tests
// ============================================================================

describe('relay_proposal', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('creates a proposal', async () => {
    vi.mocked(mockClient.createProposal).mockResolvedValue({ success: true });

    const input = relayProposalSchema.parse({
      id: 'budget-2024',
      description: 'Vote on Q1 budget allocation',
      options: ['Option A: $50k', 'Option B: $75k', 'Option C: $100k'],
    });
    const result = await handleRelayProposal(mockClient, input);

    expect(result).toBe('Proposal "budget-2024" created successfully. Options: Option A: $50k, Option B: $75k, Option C: $100k');
    expect(mockClient.createProposal).toHaveBeenCalledWith({
      id: 'budget-2024',
      description: 'Vote on Q1 budget allocation',
      options: ['Option A: $50k', 'Option B: $75k', 'Option C: $100k'],
      votingMethod: undefined,
      deadline: undefined,
    });
  });

  it('creates a proposal with voting method', async () => {
    vi.mocked(mockClient.createProposal).mockResolvedValue({ success: true });

    const input = relayProposalSchema.parse({
      id: 'critical-decision',
      description: 'Requires unanimous agreement',
      options: ['approve', 'reject'],
      voting_method: 'unanimous',
    });
    const result = await handleRelayProposal(mockClient, input);

    expect(result).toContain('created successfully');
    expect(mockClient.createProposal).toHaveBeenCalledWith({
      id: 'critical-decision',
      description: 'Requires unanimous agreement',
      options: ['approve', 'reject'],
      votingMethod: 'unanimous',
      deadline: undefined,
    });
  });

  it('creates a proposal with deadline', async () => {
    vi.mocked(mockClient.createProposal).mockResolvedValue({ success: true });
    const deadline = Date.now() + 3600000; // 1 hour from now

    const input = relayProposalSchema.parse({
      id: 'timed-vote',
      description: 'Vote must be completed within 1 hour',
      options: ['yes', 'no'],
      deadline,
    });
    const result = await handleRelayProposal(mockClient, input);

    expect(result).toContain('created successfully');
    expect(mockClient.createProposal).toHaveBeenCalledWith({
      id: 'timed-vote',
      description: 'Vote must be completed within 1 hour',
      options: ['yes', 'no'],
      votingMethod: undefined,
      deadline,
    });
  });

  it('returns error when proposal creation fails', async () => {
    vi.mocked(mockClient.createProposal).mockResolvedValue({
      success: false,
      error: 'Proposal ID already exists',
    });

    const input = relayProposalSchema.parse({
      id: 'duplicate',
      description: 'Test',
      options: ['a', 'b'],
    });
    const result = await handleRelayProposal(mockClient, input);

    expect(result).toBe('Failed to create proposal: Proposal ID already exists');
  });
});

describe('relay_vote', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('casts a vote on a proposal', async () => {
    vi.mocked(mockClient.vote).mockResolvedValue({ success: true });

    const input = relayVoteSchema.parse({
      proposal_id: 'budget-2024',
      vote: 'Option B: $75k',
    });
    const result = await handleRelayVote(mockClient, input);

    expect(result).toBe('Vote "Option B: $75k" cast on proposal "budget-2024"');
    expect(mockClient.vote).toHaveBeenCalledWith({
      proposalId: 'budget-2024',
      vote: 'Option B: $75k',
      reason: undefined,
    });
  });

  it('casts a vote with reason', async () => {
    vi.mocked(mockClient.vote).mockResolvedValue({ success: true });

    const input = relayVoteSchema.parse({
      proposal_id: 'critical-decision',
      vote: 'approve',
      reason: 'This aligns with our Q2 goals',
    });
    const result = await handleRelayVote(mockClient, input);

    expect(result).toBe('Vote "approve" cast on proposal "critical-decision"');
    expect(mockClient.vote).toHaveBeenCalledWith({
      proposalId: 'critical-decision',
      vote: 'approve',
      reason: 'This aligns with our Q2 goals',
    });
  });

  it('returns error when vote fails', async () => {
    vi.mocked(mockClient.vote).mockResolvedValue({
      success: false,
      error: 'Voting period has ended',
    });

    const input = relayVoteSchema.parse({
      proposal_id: 'expired-vote',
      vote: 'yes',
    });
    const result = await handleRelayVote(mockClient, input);

    expect(result).toBe('Failed to vote: Voting period has ended');
  });

  it('supports standard vote options', async () => {
    vi.mocked(mockClient.vote).mockResolvedValue({ success: true });

    const standardVotes = ['approve', 'reject', 'abstain'];
    for (const voteOption of standardVotes) {
      const input = relayVoteSchema.parse({
        proposal_id: 'test-proposal',
        vote: voteOption,
      });
      await handleRelayVote(mockClient, input);
    }

    expect(mockClient.vote).toHaveBeenCalledTimes(3);
  });
});

// ============================================================================
// Complete SDK/MCP Parity Integration Tests
// ============================================================================

describe('SDK/MCP parity scenarios', () => {
  let mockClient: RelayClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  it('full orchestration workflow with all tool types', async () => {
    // Setup mocks
    vi.mocked(mockClient.spawn).mockResolvedValue({ success: true });
    vi.mocked(mockClient.joinChannel).mockResolvedValue({ success: true });
    vi.mocked(mockClient.sendChannelMessage).mockResolvedValue(undefined);
    vi.mocked(mockClient.broadcast).mockResolvedValue(undefined);
    vi.mocked(mockClient.createProposal).mockResolvedValue({ success: true });
    vi.mocked(mockClient.vote).mockResolvedValue({ success: true });
    vi.mocked(mockClient.leaveChannel).mockResolvedValue({ success: true });
    vi.mocked(mockClient.release).mockResolvedValue({ success: true });

    // 1. Spawn workers
    await handleRelaySpawn(mockClient, { name: 'Worker1', cli: 'claude', task: 'Frontend' });
    await handleRelaySpawn(mockClient, { name: 'Worker2', cli: 'claude', task: 'Backend' });
    expect(mockClient.spawn).toHaveBeenCalledTimes(2);

    // 2. Join a coordination channel
    await handleRelayChannelJoin(mockClient, { channel: '#coordination' });
    expect(mockClient.joinChannel).toHaveBeenCalledWith('#coordination', undefined);

    // 3. Broadcast kickoff message
    await handleRelayBroadcast(mockClient, { message: 'Project started!' });
    expect(mockClient.broadcast).toHaveBeenCalled();

    // 4. Create a proposal for decision making
    await handleRelayProposal(mockClient, {
      id: 'arch-decision',
      description: 'Choose architecture',
      options: ['Monolith', 'Microservices'],
    });
    expect(mockClient.createProposal).toHaveBeenCalled();

    // 5. Cast votes
    await handleRelayVote(mockClient, { proposal_id: 'arch-decision', vote: 'Microservices' });
    expect(mockClient.vote).toHaveBeenCalled();

    // 6. Send channel update
    await handleRelayChannelMessage(mockClient, { channel: '#coordination', message: 'Decision made!' });
    expect(mockClient.sendChannelMessage).toHaveBeenCalled();

    // 7. Cleanup - leave channel and release workers
    await handleRelayChannelLeave(mockClient, { channel: '#coordination' });
    await handleRelayRelease(mockClient, { name: 'Worker1' });
    await handleRelayRelease(mockClient, { name: 'Worker2' });
    expect(mockClient.release).toHaveBeenCalledTimes(2);
  });

  it('shadow agent monitoring workflow', async () => {
    vi.mocked(mockClient.spawn).mockResolvedValue({ success: true });
    vi.mocked(mockClient.bindAsShadow).mockResolvedValue({ success: true });
    vi.mocked(mockClient.send).mockResolvedValue(undefined);
    vi.mocked(mockClient.unbindAsShadow).mockResolvedValue({ success: true });
    vi.mocked(mockClient.release).mockResolvedValue({ success: true });

    // 1. Spawn primary worker
    await handleRelaySpawn(mockClient, { name: 'PrimaryWorker', cli: 'claude', task: 'Main task' });

    // 2. Spawn monitor/shadow
    await handleRelaySpawn(mockClient, { name: 'Monitor', cli: 'claude', task: 'Monitor primary' });

    // 3. Bind monitor as shadow
    await handleRelayShadowBind(mockClient, {
      primary_agent: 'PrimaryWorker',
      speak_on: ['SESSION_END', 'CODE_WRITTEN'],
    });
    expect(mockClient.bindAsShadow).toHaveBeenCalledWith('PrimaryWorker', {
      speakOn: ['SESSION_END', 'CODE_WRITTEN'],
    });

    // 4. Primary does work, shadow observes (simulated by sending message)
    await handleRelaySend(mockClient, { to: 'PrimaryWorker', message: 'Do the task' });

    // 5. Unbind shadow when done
    await handleRelayShadowUnbind(mockClient, { primary_agent: 'PrimaryWorker' });
    expect(mockClient.unbindAsShadow).toHaveBeenCalledWith('PrimaryWorker');

    // 6. Release both agents
    await handleRelayRelease(mockClient, { name: 'PrimaryWorker' });
    await handleRelayRelease(mockClient, { name: 'Monitor' });
    expect(mockClient.release).toHaveBeenCalledTimes(2);
  });

  it('pub/sub topic workflow', async () => {
    vi.mocked(mockClient.spawn).mockResolvedValue({ success: true });
    vi.mocked(mockClient.subscribe).mockResolvedValue({ success: true });
    vi.mocked(mockClient.broadcast).mockResolvedValue(undefined);
    vi.mocked(mockClient.unsubscribe).mockResolvedValue({ success: true });
    vi.mocked(mockClient.release).mockResolvedValue({ success: true });

    // 1. Spawn multiple workers
    const workers = ['Worker1', 'Worker2', 'Worker3'];
    for (const name of workers) {
      await handleRelaySpawn(mockClient, { name, cli: 'claude', task: 'Subscribe test' });
    }
    expect(mockClient.spawn).toHaveBeenCalledTimes(3);

    // 2. Subscribe all workers to a topic
    for (const _ of workers) {
      await handleRelaySubscribe(mockClient, { topic: 'updates' });
    }
    expect(mockClient.subscribe).toHaveBeenCalledTimes(3);

    // 3. Broadcast to topic (simulated)
    await handleRelayBroadcast(mockClient, { message: 'Update for all subscribers' });
    expect(mockClient.broadcast).toHaveBeenCalled();

    // 4. Unsubscribe workers
    for (const _ of workers) {
      await handleRelayUnsubscribe(mockClient, { topic: 'updates' });
    }
    expect(mockClient.unsubscribe).toHaveBeenCalledTimes(3);

    // 5. Release workers
    for (const name of workers) {
      await handleRelayRelease(mockClient, { name });
    }
    expect(mockClient.release).toHaveBeenCalledTimes(3);
  });

  it('multi-channel coordination workflow', async () => {
    vi.mocked(mockClient.joinChannel).mockResolvedValue({ success: true });
    vi.mocked(mockClient.sendChannelMessage).mockResolvedValue(undefined);
    vi.mocked(mockClient.leaveChannel).mockResolvedValue({ success: true });

    const channels = ['#frontend', '#backend', '#devops'];

    // 1. Join multiple channels
    for (const channel of channels) {
      await handleRelayChannelJoin(mockClient, { channel });
    }
    expect(mockClient.joinChannel).toHaveBeenCalledTimes(3);

    // 2. Send messages to each channel
    for (const channel of channels) {
      await handleRelayChannelMessage(mockClient, { channel, message: `Update for ${channel}` });
    }
    expect(mockClient.sendChannelMessage).toHaveBeenCalledTimes(3);

    // 3. Leave all channels
    for (const channel of channels) {
      await handleRelayChannelLeave(mockClient, { channel, reason: 'Task complete' });
    }
    expect(mockClient.leaveChannel).toHaveBeenCalledTimes(3);
  });
});
