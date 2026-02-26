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

function createBrokerClientMock(overrides: Partial<MessagingBrokerClient> = {}): MessagingBrokerClient {
  return {
    sendMessage: vi.fn(async () => ({ event_id: 'evt_1', targets: [] })),
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
  createRelaycastError?: Error;
}) {
  const brokerClient = options?.brokerClient ?? createBrokerClientMock();
  const relaycastClient = options?.relaycastClient ?? createRelaycastClientMock();
  const projectRoot = options?.projectRoot ?? '/tmp/project';
  const createRelaycastError = options?.createRelaycastError;

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as MessagingDependencies['exit'];

  const deps: MessagingDependencies = {
    getProjectRoot: vi.fn(() => projectRoot),
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
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({ agentName: '__cli_read__' });
    expect(relaycastClient.message).toHaveBeenCalledWith('msg_123');
    expect(deps.log).toHaveBeenNthCalledWith(1, 'From: Lead');
    expect(deps.log).toHaveBeenNthCalledWith(2, 'To: #channel');
    expect(deps.log).toHaveBeenNthCalledWith(3, 'Time: 2026-02-20T10:00:00.000Z');
    expect(deps.log).toHaveBeenNthCalledWith(4, '---');
    expect(deps.log).toHaveBeenNthCalledWith(5, 'Detailed body');
  });

  it('shows message history with limit option', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        {
          id: 'm3',
          agent_name: 'Three',
          text: 'third',
          created_at: '2026-02-20T11:00:03.000Z',
        },
        {
          id: 'm2',
          agent_name: 'Two',
          text: 'second',
          created_at: '2026-02-20T11:00:02.000Z',
        },
        {
          id: 'm1',
          agent_name: 'One',
          text: 'first',
          created_at: '2026-02-20T11:00:01.000Z',
        },
      ]),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--limit', '2']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({ agentName: '__cli_history__' });
    expect(relaycastClient.messages).toHaveBeenCalledWith('general', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:03.000Z] Three -> #general: third');
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:02.000Z] Two -> #general: second');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('One -> #general'));
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
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({ agentName: '__cli_inbox__' });
    expect(deps.log).toHaveBeenCalledWith('Unread Channels:');
    expect(deps.log).toHaveBeenCalledWith('  #general: 2');
    expect(deps.log).toHaveBeenCalledWith('Mentions:');
    expect(deps.log).toHaveBeenCalledWith('  [2026-02-20T12:00:00.000Z] #general @Lead: Please review this.');
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
