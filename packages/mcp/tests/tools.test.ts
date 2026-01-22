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
      from: 'Worker',
      content: 'Done!',
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
});
