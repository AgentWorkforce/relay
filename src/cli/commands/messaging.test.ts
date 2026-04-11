import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  registerMessagingCommands,
  type MessagingBrokerClient,
  type MessagingDependencies,
  type MessagingRelaycastClient,
} from './messaging.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

function createBrokerClientMock(
  overrides: Partial<MessagingBrokerClient> = {}
): MessagingBrokerClient {
  return {
    sendMessage: vi.fn(async () => ({ event_id: 'evt_1', targets: [] })),
    getMessageHistory: vi.fn(async () => []),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createRelaycastClientMock(
  overrides: Partial<MessagingRelaycastClient> = {}
): MessagingRelaycastClient {
  return {
    message: vi.fn(async () => ({
      id: 'msg_1',
      agent_name: 'WorkerA',
      text: 'hello',
      created_at: '2026-02-20T00:00:00.000Z',
    })),
    messages: vi.fn(async () => []),
    inbox: vi.fn(async () => ({
      unread_channels: [],
      mentions: [],
      unread_dms: [],
    })),
    ...overrides,
  };
}

function createHarness(options?: {
  brokerClient?: MessagingBrokerClient;
  relaycastClient?: MessagingRelaycastClient;
  projectRoot?: string;
  createConnectError?: Error;
  createRelaycastError?: Error;
}) {
  const brokerClient = options?.brokerClient ?? createBrokerClientMock();
  const relaycastClient = options?.relaycastClient ?? createRelaycastClientMock();
  const projectRoot = options?.projectRoot ?? '/tmp/project';
  const createConnectError = options?.createConnectError;
  const createRelaycastError = options?.createRelaycastError;

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as MessagingDependencies['exit'];

  const deps: MessagingDependencies = {
    getProjectRoot: vi.fn(() => projectRoot),
    connectClient: vi.fn(async () => {
      if (createConnectError) {
        throw createConnectError;
      }
      return brokerClient;
    }),
    createClient: vi.fn(() => brokerClient),
    createRelaycastClient: vi.fn(async () => {
      if (createRelaycastError) {
        throw createRelaycastError;
      }
      return relaycastClient;
    }),
    log: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    exit,
  };

  const program = new Command();
  program.exitOverride();
  registerMessagingCommands(program, deps);

  return { program, deps, brokerClient, relaycastClient };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err: any) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    if (typeof err?.exitCode === 'number') {
      return err.exitCode;
    }
    throw err;
  }
}

describe('registerMessagingCommands', () => {
  it('registers messaging commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(expect.arrayContaining(['send', 'read', 'history', 'inbox']));
  });

  it('sends a message to the correct target', async () => {
    const brokerClient = createBrokerClientMock();
    const { program, deps } = createHarness({ brokerClient });

    const exitCode = await runCommand(program, [
      'send',
      'WorkerA',
      'Ship this today',
      '--from',
      'Alice',
      '--thread',
      'thread-1',
    ]);

    expect(exitCode).toBeUndefined();
    expect(deps.createClient).toHaveBeenCalledWith('/tmp/project');
    expect(brokerClient.sendMessage).toHaveBeenCalledWith({
      to: 'WorkerA',
      text: 'Ship this today',
      from: 'Alice',
      threadId: 'thread-1',
    });
    expect(brokerClient.shutdown).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('Message sent to WorkerA');
  });

  it('lets the broker choose the default sender when --from is omitted', async () => {
    const brokerClient = createBrokerClientMock();
    const { program } = createHarness({ brokerClient });

    const exitCode = await runCommand(program, ['send', 'WorkerA', 'Ship this today']);

    expect(exitCode).toBeUndefined();
    expect(brokerClient.sendMessage).toHaveBeenCalledWith({
      to: 'WorkerA',
      text: 'Ship this today',
    });
  });

  it('uses AGENT_RELAY_SENDER when configured and --from is omitted', async () => {
    const brokerClient = createBrokerClientMock();
    const originalSender = process.env.AGENT_RELAY_SENDER;
    process.env.AGENT_RELAY_SENDER = 'relay-operator';
    const { program } = createHarness({ brokerClient });

    try {
      const exitCode = await runCommand(program, ['send', 'WorkerA', 'Ship this today']);

      expect(exitCode).toBeUndefined();
      expect(brokerClient.sendMessage).toHaveBeenCalledWith({
        to: 'WorkerA',
        text: 'Ship this today',
        from: 'relay-operator',
      });
    } finally {
      if (originalSender === undefined) {
        delete process.env.AGENT_RELAY_SENDER;
      } else {
        process.env.AGENT_RELAY_SENDER = originalSender;
      }
    }
  });

  it('treats a blank --from value as omitted so local broker defaults still work', async () => {
    const brokerClient = createBrokerClientMock();
    const originalSender = process.env.AGENT_RELAY_SENDER;
    delete process.env.AGENT_RELAY_SENDER;
    const { program } = createHarness({ brokerClient });

    try {
      const exitCode = await runCommand(program, ['send', 'WorkerA', 'Ship this today', '--from', '   ']);

      expect(exitCode).toBeUndefined();
      expect(brokerClient.sendMessage).toHaveBeenCalledWith({
        to: 'WorkerA',
        text: 'Ship this today',
      });
    } finally {
      if (originalSender === undefined) {
        delete process.env.AGENT_RELAY_SENDER;
      } else {
        process.env.AGENT_RELAY_SENDER = originalSender;
      }
    }
  });

  it('reads a message by ID', async () => {
    const relaycastClient = createRelaycastClientMock({
      message: vi.fn(async () => ({
        id: 'msg_123',
        agent_name: 'Lead',
        text: 'Detailed body',
        created_at: '2026-02-20T10:00:00.000Z',
      })),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['read', 'msg_123']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: '__cli_read__',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.message).toHaveBeenCalledWith('msg_123');
    expect(deps.log).toHaveBeenNthCalledWith(1, 'From: Lead');
    expect(deps.log).toHaveBeenNthCalledWith(2, 'To: #channel');
    expect(deps.log).toHaveBeenNthCalledWith(3, 'Time: 2026-02-20T10:00:00.000Z');
    expect(deps.log).toHaveBeenNthCalledWith(4, '---');
    expect(deps.log).toHaveBeenNthCalledWith(5, 'Detailed body');
  });

  it('shows message history with limit option', async () => {
    const brokerClient = createBrokerClientMock({
      getMessageHistory: vi.fn(async () => [
        {
          event_id: 'm3',
          from: 'Three',
          target: '#general',
          text: 'third',
          timestamp: '2026-02-20T11:00:03.000Z',
        },
        {
          event_id: 'm2',
          from: 'Two',
          target: '#general',
          text: 'second',
          timestamp: '2026-02-20T11:00:02.000Z',
        },
        {
          event_id: 'm1',
          from: 'One',
          target: '#general',
          text: 'first',
          timestamp: '2026-02-20T11:00:01.000Z',
        },
      ]),
    });
    const { program, deps } = createHarness({ brokerClient });

    const exitCode = await runCommand(program, ['history', '--limit', '2']);

    expect(exitCode).toBeUndefined();
    expect(deps.connectClient).toHaveBeenCalledWith('/tmp/project');
    expect(brokerClient.getMessageHistory).toHaveBeenCalledTimes(1);
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:03.000Z] Three -> #general: third');
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:02.000Z] Two -> #general: second');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('One -> #general'));
  });

  it('shows message history as JSON with stable payload fields', async () => {
    const brokerClient = createBrokerClientMock({
      getMessageHistory: vi.fn(async () => [
        {
          event_id: 'm1',
          from: 'One',
          target: 'WorkerA',
          text: 'first',
          thread_id: 'thread-1',
          timestamp: '2026-02-20T11:00:01.000Z',
        },
      ]),
    });
    const { program, deps } = createHarness({ brokerClient });

    const exitCode = await runCommand(program, ['history', '--json', '--limit', '1']);

    expect(exitCode).toBeUndefined();
    expect(deps.connectClient).toHaveBeenCalledWith('/tmp/project');
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual([
      {
        id: 'm1',
        ts: Date.parse('2026-02-20T11:00:01.000Z'),
        timestamp: '2026-02-20T11:00:01.000Z',
        from: 'One',
        to: 'WorkerA',
        thread: 'thread-1',
        kind: 'message',
        body: 'first',
      },
    ]);
  });

  it('falls back to relaycast history when no local broker is available', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        {
          id: 'm1',
          agent_name: 'One',
          text: 'first',
          created_at: '2026-02-20T11:00:01.000Z',
        },
      ]),
    });
    const { program, deps } = createHarness({
      relaycastClient,
      createConnectError: new Error('No running broker found'),
    });
    const originalApiKey = process.env.RELAY_API_KEY;
    process.env.RELAY_API_KEY = 'rk_test_123';

    try {
      const exitCode = await runCommand(program, ['history', '--limit', '1']);

      expect(exitCode).toBeUndefined();
      expect(deps.createRelaycastClient).toHaveBeenCalledWith({
        agentName: '__cli_history__',
        cwd: '/tmp/project',
      });
      expect(relaycastClient.messages).toHaveBeenCalledWith('general', { limit: 100 });
      expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:01.000Z] One -> #general: first');
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.RELAY_API_KEY;
      } else {
        process.env.RELAY_API_KEY = originalApiKey;
      }
    }
  });

  it('falls back to relaycast history without RELAY_API_KEY when the broker session is still reachable', async () => {
    const brokerClient = createBrokerClientMock({
      getMessageHistory: vi.fn(async () => {
        throw new Error('history backend unavailable');
      }),
    });
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        {
          id: 'm1',
          agent_name: 'One',
          text: 'first',
          created_at: '2026-02-20T11:00:01.000Z',
        },
      ]),
    });
    const { program, deps } = createHarness({
      brokerClient,
      relaycastClient,
    });
    const originalApiKey = process.env.RELAY_API_KEY;
    delete process.env.RELAY_API_KEY;

    try {
      const exitCode = await runCommand(program, ['history', '--limit', '1']);

      expect(exitCode).toBeUndefined();
      expect(deps.connectClient).toHaveBeenCalledWith('/tmp/project');
      expect(deps.createRelaycastClient).toHaveBeenCalledWith({
        agentName: '__cli_history__',
        cwd: '/tmp/project',
      });
      expect(relaycastClient.messages).toHaveBeenCalledWith('general', { limit: 100 });
      expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:01.000Z] One -> #general: first');
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.RELAY_API_KEY;
      } else {
        process.env.RELAY_API_KEY = originalApiKey;
      }
    }
  });

  it('explains how to fix history when local broker and relaycast key are both unavailable', async () => {
    const { program, deps } = createHarness({
      createConnectError: new Error('No running broker found'),
    });
    const originalApiKey = process.env.RELAY_API_KEY;
    delete process.env.RELAY_API_KEY;

    try {
      const exitCode = await runCommand(program, ['history']);

      expect(exitCode).toBe(1);
      expect(deps.error).toHaveBeenCalledWith('Failed to read local broker history: No running broker found');
      expect(deps.error).toHaveBeenCalledWith(
        'No Relaycast API key found in RELAY_API_KEY. Start the local broker with `agent-relay up` and retry, or set RELAY_API_KEY to read Relaycast history.'
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.RELAY_API_KEY;
      } else {
        process.env.RELAY_API_KEY = originalApiKey;
      }
    }
  });

  it('clarifies local-only mode when relaycast fallback has no workspace key to use', async () => {
    const brokerClient = createBrokerClientMock({
      getMessageHistory: vi.fn(async () => {
        throw new Error('history backend unavailable');
      }),
    });
    const { program, deps } = createHarness({
      brokerClient,
      createRelaycastError: new Error(
        'Relaycast API key not found in RELAY_API_KEY or the running broker session'
      ),
    });
    const originalApiKey = process.env.RELAY_API_KEY;
    delete process.env.RELAY_API_KEY;

    try {
      const exitCode = await runCommand(program, ['history']);

      expect(exitCode).toBe(1);
      expect(deps.error).toHaveBeenCalledWith(
        'Relaycast history is unavailable because this broker is running in local-only mode and no RELAY_API_KEY is configured.'
      );
      expect(deps.error).toHaveBeenCalledWith(
        'Local broker history was unavailable: history backend unavailable'
      );
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.RELAY_API_KEY;
      } else {
        process.env.RELAY_API_KEY = originalApiKey;
      }
    }
  });

  it('shows unread inbox summary', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unread_channels: [{ channel_name: 'general', unread_count: 2 }],
        mentions: [
          {
            id: 'mention_1',
            channel_name: 'general',
            agent_name: 'Lead',
            text: 'Please review this.',
            created_at: '2026-02-20T12:00:00.000Z',
          },
        ],
        unread_dms: [{ conversation_id: 'dm_1', from: 'Teammate', unread_count: 1, last_message: null }],
      })),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: '__cli_inbox__',
      cwd: '/tmp/project',
    });
    expect(deps.log).toHaveBeenCalledWith('Unread Channels:');
    expect(deps.log).toHaveBeenCalledWith('  #general: 2');
    expect(deps.log).toHaveBeenCalledWith('Mentions:');
    expect(deps.log).toHaveBeenCalledWith(
      '  [2026-02-20T12:00:00.000Z] #general @Lead: Please review this.'
    );
    expect(deps.log).toHaveBeenCalledWith('Unread DMs:');
    expect(deps.log).toHaveBeenCalledWith('  Teammate: 1');
  });

  it('returns non-zero for missing required args', async () => {
    const { program, brokerClient } = createHarness();

    const exitCode = await runCommand(program, ['send', 'WorkerOnly']);

    expect(exitCode).toBe(1);
    expect(brokerClient.sendMessage).not.toHaveBeenCalled();
  });

  it('handles broker unavailable errors', async () => {
    const { program, deps } = createHarness({
      createRelaycastError: new Error('broker unavailable'),
    });

    const exitCode = await runCommand(program, ['read', 'msg_broken']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to initialize relaycast client: broker unavailable');
    expect(deps.error).toHaveBeenCalledWith('Start the broker with `agent-relay up` and try again.');
  });
});
