import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleRelaySend,
  handleRelayInbox,
  handleRelayWho,
} from '../src/tools/index.js';

describe('relay_send', () => {
  const mockClient = {
    send: vi.fn(),
    sendAndWait: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a direct message', async () => {
    mockClient.send.mockResolvedValue(undefined);

    const result = await handleRelaySend(mockClient as any, {
      to: 'Alice',
      message: 'Hello',
    });

    expect(result).toBe('Message sent to Alice');
    expect(mockClient.send).toHaveBeenCalledWith('Alice', 'Hello', { thread: undefined });
  });

  it('sends to a channel', async () => {
    mockClient.send.mockResolvedValue(undefined);

    const result = await handleRelaySend(mockClient as any, {
      to: '#general',
      message: 'Team update',
    });

    expect(result).toBe('Message sent to #general');
    expect(mockClient.send).toHaveBeenCalledWith('#general', 'Team update', { thread: undefined });
  });

  it('awaits response when requested', async () => {
    mockClient.sendAndWait.mockResolvedValue({
      from: 'Worker',
      content: 'Done!',
    });

    const result = await handleRelaySend(mockClient as any, {
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
  const mockClient = {
    getInbox: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no messages message when inbox empty', async () => {
    mockClient.getInbox.mockResolvedValue([]);

    const result = await handleRelayInbox(mockClient as any, {});

    expect(result).toBe('No messages in inbox.');
    expect(mockClient.getInbox).toHaveBeenCalledWith({});
  });

  it('formats messages with channel and thread', async () => {
    mockClient.getInbox.mockResolvedValue([
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

    const result = await handleRelayInbox(mockClient as any, {
      limit: 5,
      unread_only: true,
      from: 'Lead',
    });

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
  const mockClient = {
    listAgents: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns message when no agents online', async () => {
    mockClient.listAgents.mockResolvedValue([]);

    const result = await handleRelayWho(mockClient as any, {});

    expect(result).toBe('No agents online.');
    expect(mockClient.listAgents).toHaveBeenCalledWith({});
  });

  it('lists agents with status and parent info', async () => {
    mockClient.listAgents.mockResolvedValue([
      { name: 'Alice', cli: 'claude', idle: false },
      { name: 'Bob', cli: 'codex', idle: true },
      { name: 'Worker1', cli: 'claude', idle: false, parent: 'Alice' },
    ]);

    const result = await handleRelayWho(mockClient as any, { include_idle: true, project: 'proj' });

    expect(mockClient.listAgents).toHaveBeenCalledWith({ include_idle: true, project: 'proj' });
    expect(result).toContain('3 agent(s) online:');
    expect(result).toContain('- Alice (claude) - active');
    expect(result).toContain('- Bob (codex) - idle');
    expect(result).toContain('- Worker1 (claude) - active [worker of: Alice]');
  });
});
