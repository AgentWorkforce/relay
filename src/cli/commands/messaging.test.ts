import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
      recent_reactions: [],
    })),
    dm: vi.fn(async () => undefined),
    post: vi.fn(async () => undefined),
    dms: {
      conversations: vi.fn(async () => []),
      messages: vi.fn(async () => []),
    },
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
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
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
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('registers messaging commands on the program', () => {
    const { program } = createHarness();
    const commandNames = program.commands.map((cmd) => cmd.name());

    expect(commandNames).toEqual(expect.arrayContaining(['send', 'read', 'history', 'inbox', 'replies']));
  });

  it('sends a DM via relaycast SDK registered as the --from identity', async () => {
    const relaycastClient = createRelaycastClientMock();
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['send', 'WorkerA', 'Ship this today', '--from', 'Alice']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'Alice',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.dm).toHaveBeenCalledWith('WorkerA', 'Ship this today');
    expect(deps.log).toHaveBeenCalledWith('Message sent to WorkerA');
    // broker path not used
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('defaults sender to "orchestrator" when --from is not provided', async () => {
    const relaycastClient = createRelaycastClientMock();
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['send', 'WorkerA', 'Ship this today']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'orchestrator',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.dm).toHaveBeenCalledWith('WorkerA', 'Ship this today');
  });

  it('send honors AGENT_RELAY_ORCHESTRATOR_NAME when --from omitted', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_NAME', 'ops');
    const relaycastClient = createRelaycastClientMock();
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['send', 'WorkerA', 'Ship this today']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'ops',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.dm).toHaveBeenCalledWith('WorkerA', 'Ship this today');
  });

  it('send --from explicit value beats env', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_NAME', 'ops');
    const relaycastClient = createRelaycastClientMock();
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['send', 'WorkerA', 'Ship this today', '--from', 'Alice']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'Alice',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.dm).toHaveBeenCalledWith('WorkerA', 'Ship this today');
  });

  it('sends to a channel via relaycast post when agent starts with #', async () => {
    const relaycastClient = createRelaycastClientMock();
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['send', '#general', 'Hello team']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'orchestrator',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.post).toHaveBeenCalledWith('general', 'Hello team');
    expect(relaycastClient.dm).not.toHaveBeenCalled();
  });

  it('falls back to broker when relaycast is unavailable', async () => {
    const brokerClient = createBrokerClientMock();
    const { program, deps } = createHarness({
      brokerClient,
      createRelaycastError: new Error('no api key'),
    });

    const exitCode = await runCommand(program, ['send', 'WorkerA', 'fallback msg', '--from', 'Alice']);

    expect(exitCode).toBeUndefined();
    expect(brokerClient.sendMessage).toHaveBeenCalledWith({
      to: 'WorkerA',
      text: 'fallback msg',
      from: 'Alice',
      threadId: undefined,
    });
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
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: '__cli_history__',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.messages).toHaveBeenCalledWith('general', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:03.000Z] Three -> #general: third');
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T11:00:02.000Z] Two -> #general: second');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('One -> #general'));
  });

  it('channel history prints full untruncated text in chronological order', async () => {
    const longLine = 'X'.repeat(400);
    const relaycastClient = createRelaycastClientMock({
      // Deliberately returned newest-first / out of order to prove the
      // command re-sorts chronologically instead of trusting feed order.
      messages: vi.fn(async () => [
        {
          id: 'm2',
          agent_name: 'SstVerify',
          text: 'GO/NO-GO: GO\nrationale line 2',
          created_at: '2026-02-20T11:00:05.000Z',
        },
        {
          id: 'm1',
          agent_name: 'SstFix',
          text: longLine,
          created_at: '2026-02-20T11:00:01.000Z',
        },
      ]),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--to', '#phase3']);

    expect(exitCode).toBeUndefined();
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    // Full 400-char payload, no "..." truncation.
    expect(logged).toContain(`[2026-02-20T11:00:01.000Z] SstFix -> #phase3: ${longLine}`);
    expect(logged.some((l) => l.includes('...'))).toBe(false);
    // Multi-line message rendered under an indented header.
    expect(logged).toContain('[2026-02-20T11:00:05.000Z] SstVerify -> #phase3:');
    expect(logged).toContain('  GO/NO-GO: GO');
    expect(logged).toContain('  rationale line 2');
    // Chronological order: older SstFix header logged before newer SstVerify.
    const fixIdx = logged.findIndex((l) => l.includes('SstFix -> #phase3'));
    const verifyIdx = logged.findIndex((l) => l.includes('SstVerify -> #phase3'));
    expect(fixIdx).toBeGreaterThanOrEqual(0);
    expect(fixIdx).toBeLessThan(verifyIdx);
  });

  it('shows message history as JSON with stable payload fields', async () => {
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
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--json', '--limit', '1']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: '__cli_history__',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.messages).toHaveBeenCalledWith('general', { limit: 100 });
    expect(deps.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual([
      {
        id: 'm1',
        ts: Date.parse('2026-02-20T11:00:01.000Z'),
        timestamp: '2026-02-20T11:00:01.000Z',
        from: 'One',
        to: '#general',
        thread: null,
        kind: 'message',
        body: 'first',
      },
    ]);
  });

  it('history --from applies the limit after combining channel and DM messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        {
          id: 'ch_old',
          agent_name: 'relay',
          text: 'channel old',
          created_at: '2026-02-20T12:00:01.000Z',
        },
        {
          id: 'ch_new',
          agent_name: 'relay',
          text: 'channel new',
          created_at: '2026-02-20T12:00:04.000Z',
        },
      ]),
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'dm_1',
            participants: [{ agentName: 'relay' }, { agentName: 'orchestrator' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'dm_old',
            agentName: 'relay',
            text: 'dm old',
            createdAt: '2026-02-20T12:00:02.000Z',
          },
          {
            id: 'dm_new',
            agentName: 'relay',
            text: 'dm new',
            createdAt: '2026-02-20T12:00:03.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--limit', '2']);

    expect(exitCode).toBeUndefined();
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain('dm new');
    expect(logged[1]).toContain('channel new');
    expect(logged.some((line) => line.includes('channel old') || line.includes('dm old'))).toBe(false);
  });

  it('history --from --json applies the limit after combining channel and DM messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        {
          id: 'ch_old',
          agent_name: 'relay',
          text: 'channel old',
          created_at: '2026-02-20T12:00:01.000Z',
        },
        {
          id: 'ch_new',
          agent_name: 'relay',
          text: 'channel new',
          created_at: '2026-02-20T12:00:04.000Z',
        },
      ]),
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'dm_1',
            participants: [{ agentName: 'relay' }, { agentName: 'orchestrator' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'dm_old',
            agentName: 'relay',
            text: 'dm old',
            createdAt: '2026-02-20T12:00:02.000Z',
          },
          {
            id: 'dm_new',
            agentName: 'relay',
            text: 'dm new',
            createdAt: '2026-02-20T12:00:03.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--limit', '2', '--json']);

    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(parsed.map((item: { text: string }) => item.text)).toEqual(['dm new', 'channel new']);
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
        unread_dms: [
          {
            conversation_id: 'dm_1',
            from: 'Teammate',
            unread_count: 1,
            last_message: {
              id: 'dm_msg_1',
              text: 'Please check the latest patch.',
              created_at: '2026-02-20T12:01:00.000Z',
            },
          },
        ],
        recent_reactions: [],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'dm_msg_1',
            agentName: 'Teammate',
            text: 'Please check the latest patch.',
            createdAt: '2026-02-20T12:01:00.000Z',
          },
        ]),
      },
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
    expect(deps.log).toHaveBeenCalledWith('  [2026-02-20T12:00:00.000Z] #general @Lead: Please review this.');
    expect(deps.log).toHaveBeenCalledWith('Unread DMs:');
    expect(deps.log).toHaveBeenCalledWith('  Teammate → __cli_inbox__ (1 unread):');
    expect(deps.log).toHaveBeenCalledWith(
      '    [2026-02-20T12:01:00.000Z] Teammate: Please check the latest patch.'
    );
  });

  it('normalizes camelCase inbox payloads from the Relaycast SDK', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadChannels: [{ channelName: 'general', unreadCount: 2 }],
        mentions: [
          {
            id: 'mention_1',
            channelName: 'general',
            agentName: 'Lead',
            text: 'Please review this.',
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ],
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Teammate',
            unreadCount: 1,
            lastMessage: {
              id: 'msg_1',
              text: 'hello',
              createdAt: '2026-02-20T12:01:00.000Z',
            },
          },
        ],
        recentReactions: [
          {
            messageId: 'msg_2',
            channelName: 'general',
            emoji: 'eyes',
            agentName: 'Reviewer',
            createdAt: '2026-02-20T12:02:00.000Z',
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'Teammate',
            text: 'hello',
            createdAt: '2026-02-20T12:01:00.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Unread Channels:');
    expect(deps.log).toHaveBeenCalledWith('  #general: 2');
    expect(deps.log).toHaveBeenCalledWith('Mentions:');
    expect(deps.log).toHaveBeenCalledWith('  [2026-02-20T12:00:00.000Z] #general @Lead: Please review this.');
    expect(deps.log).toHaveBeenCalledWith('Unread DMs:');
    expect(deps.log).toHaveBeenCalledWith('  Teammate → __cli_inbox__ (1 unread):');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:01:00.000Z] Teammate: hello');
    expect(deps.log).toHaveBeenCalledWith('Recent Reactions:');
    expect(deps.log).toHaveBeenCalledWith('  [2026-02-20T12:02:00.000Z] #general eyes by @Reviewer');
  });

  it('emits snake_case inbox --json payload even when SDK returns camelCase', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadChannels: [{ channelName: 'general', unreadCount: 2 }],
        mentions: [
          {
            id: 'mention_1',
            channelName: 'general',
            agentName: 'Lead',
            text: 'Please review this.',
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ],
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Teammate',
            unreadCount: 1,
            lastMessage: {
              id: 'msg_1',
              text: 'hello',
              createdAt: '2026-02-20T12:01:00.000Z',
            },
          },
          {
            conversationId: 'dm_2',
            from: 'WorkerA',
            unreadCount: 1,
            lastMessage: {
              id: 'msg_3',
              text: 'operator echo',
              createdAt: '2026-02-20T12:03:00.000Z',
            },
          },
          {
            conversationId: 'dm_3',
            from: 'WorkerB',
            unreadCount: 1,
            lastMessage: {
              id: 'msg_4',
              text: 'explicit outbound echo',
              createdAt: '2026-02-20T12:04:00.000Z',
            },
          },
        ],
        recentReactions: [
          {
            messageId: 'msg_2',
            channelName: 'general',
            emoji: 'eyes',
            agentName: 'Reviewer',
            createdAt: '2026-02-20T12:02:00.000Z',
          },
        ],
      })),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--agent', 'orchestrator', '--json']);

    expect(exitCode).toBeUndefined();
    const jsonCall = (deps.log as any).mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).trimStart().startsWith('{')
    );
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0] as string);
    expect(parsed).toEqual({
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
      unread_dms: [
        {
          conversation_id: 'dm_1',
          from: 'Teammate',
          unread_count: 1,
          last_message: {
            id: 'msg_1',
            text: 'hello',
            created_at: '2026-02-20T12:01:00.000Z',
            direction: 'inbound',
          },
        },
        {
          conversation_id: 'dm_2',
          from: 'WorkerA',
          unread_count: 1,
          last_message: {
            id: 'msg_3',
            text: 'operator echo',
            created_at: '2026-02-20T12:03:00.000Z',
            direction: 'inbound',
          },
        },
        {
          conversation_id: 'dm_3',
          from: 'WorkerB',
          unread_count: 1,
          last_message: {
            id: 'msg_4',
            text: 'explicit outbound echo',
            created_at: '2026-02-20T12:04:00.000Z',
            direction: 'inbound',
          },
        },
      ],
      recent_reactions: [
        {
          message_id: 'msg_2',
          channel_name: 'general',
          emoji: 'eyes',
          agent_name: 'Reviewer',
          created_at: '2026-02-20T12:02:00.000Z',
        },
      ],
    });
  });

  it('treats partial inbox payloads as empty instead of crashing', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({}) as any),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Inbox is clear.');
    expect(deps.error).not.toHaveBeenCalled();
  });

  it('drops malformed unread DMs without a sender instead of crashing', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            unreadCount: 1,
            lastMessage: {
              id: 'msg_1',
              text: 'missing sender',
              createdAt: '2026-02-20T12:01:00.000Z',
            },
          },
        ],
      })) as any,
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Inbox is clear.');
    expect(deps.error).not.toHaveBeenCalled();
  });

  it('inbox ignores synchronous disconnect cleanup failures', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unread_channels: [],
        mentions: [],
        unread_dms: [],
        recent_reactions: [],
      })),
      disconnect: vi.fn(() => {
        throw new Error('disconnect failed');
      }),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Inbox is clear.');
    expect(relaycastClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it('inbox --agent rejects unauthorized read identities before creating a client', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['inbox', '--agent', 'my-worker']);

    expect(exitCode).toBe(1);
    expect(deps.createRelaycastClient).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      'Refusing to read as my-worker: read identities must be the configured orchestrator or listed in AGENT_RELAY_ALLOWED_READ_IDENTITIES.'
    );
  });

  it('inbox --agent allows the configured orchestrator identity', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_NAME', 'ops');
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['inbox', '--agent', 'ops']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'ops',
      cwd: '/tmp/project',
    });
  });

  it('replies <agent> returns only inbound messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'first inbound',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
          {
            id: 'msg_2',
            agentName: 'orchestrator',
            text: 'outbound response',
            createdAt: '2026-02-20T12:00:02.000Z',
          },
          {
            id: 'msg_3',
            agentName: 'WorkerA',
            text: 'second inbound',
            createdAt: '2026-02-20T12:00:03.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith(
      'conv_1',
      expect.objectContaining({ limit: expect.any(Number) })
    );
    expect(deps.log).toHaveBeenNthCalledWith(1, '[2026-02-20T12:00:01.000Z] WorkerA: first inbound');
    expect(deps.log).toHaveBeenNthCalledWith(2, '[2026-02-20T12:00:03.000Z] WorkerA: second inbound');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('outbound response'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('→ orchestrator'));
  });

  it('replies <agent> --since <id> returns only messages after that id (no replay)', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          { id: 'm1', agentName: 'WorkerA', text: 'old one', createdAt: '2026-02-20T12:00:01.000Z' },
          { id: 'm2', agentName: 'WorkerA', text: 'cursor msg', createdAt: '2026-02-20T12:00:02.000Z' },
          { id: 'm3', agentName: 'WorkerA', text: 'new one', createdAt: '2026-02-20T12:00:03.000Z' },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--since', 'm2']);

    expect(exitCode).toBeUndefined();
    // Only messages strictly AFTER the cursor id m2 — never m1/m2 again.
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:00:03.000Z] WorkerA: new one');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('old one'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('cursor msg'));
  });

  it('replies <agent> --since <unknown id> returns nothing rather than replaying history', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          { id: 'm1', agentName: 'WorkerA', text: 'one', createdAt: '2026-02-20T12:00:01.000Z' },
          { id: 'm2', agentName: 'WorkerA', text: 'two', createdAt: '2026-02-20T12:00:02.000Z' },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--since', 'rolled-off-id']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('No messages found.');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('one'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('two'));
  });

  it('replies <agent> selects the conversation shared by the reader and agent', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_architect_worker',
            participants: [{ agentName: 'Architect' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
          {
            id: 'conv_orchestrator_worker',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:01:00.000Z',
          },
        ]),
        messages: vi.fn(async (conversationId: string) => {
          if (conversationId === 'conv_architect_worker') {
            return [
              {
                id: 'msg_wrong',
                agentName: 'WorkerA',
                text: 'wrong reader transcript',
                createdAt: '2026-02-20T12:00:01.000Z',
              },
            ];
          }
          return [
            {
              id: 'msg_right',
              agentName: 'WorkerA',
              text: 'correct reader transcript',
              createdAt: '2026-02-20T12:01:01.000Z',
            },
          ];
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(1);
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith(
      'conv_orchestrator_worker',
      expect.objectContaining({ limit: expect.any(Number) })
    );
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:01:01.000Z] WorkerA: correct reader transcript');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('wrong reader transcript'));
  });

  it('replies <agent> selects the 1:1 conversation before a group DM with the same agent', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_group',
            type: 'group',
            participants: [
              { agentName: 'orchestrator' },
              { agentName: 'Worker2' },
              { agentName: 'Architect' },
            ],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
          {
            id: 'conv_direct',
            type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'Worker2' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:01:00.000Z',
          },
        ]),
        messages: vi.fn(async (conversationId: string) => {
          if (conversationId === 'conv_group') {
            return [
              {
                id: 'msg_group',
                agentName: 'Worker2',
                text: 'group-only reply',
                createdAt: '2026-02-20T12:00:01.000Z',
              },
            ];
          }
          return [
            {
              id: 'msg_direct',
              agentName: 'Worker2',
              text: 'direct reply',
              createdAt: '2026-02-20T12:01:01.000Z',
            },
          ];
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'Worker2']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(1);
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith(
      'conv_direct',
      expect.objectContaining({ limit: expect.any(Number) })
    );
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:01:01.000Z] Worker2: direct reply');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('group-only reply'));
  });

  it('replies <agent> selects a typed 1:1 conversation before an untyped exact participant match', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_untyped',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'Worker2' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
          {
            id: 'conv_typed',
            type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'Worker2' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:01:00.000Z',
          },
        ]),
        messages: vi.fn(async (conversationId: string) => [
          {
            id: `${conversationId}_msg`,
            agentName: 'Worker2',
            text: `${conversationId} reply`,
            createdAt: '2026-02-20T12:01:01.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'Worker2']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(1);
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith(
      'conv_typed',
      expect.objectContaining({ limit: expect.any(Number) })
    );
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('conv_typed reply'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('conv_untyped reply'));
  });

  it('replies <agent> --as selects the conversation shared by the overridden reader and agent', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_NAME', 'ops');
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_orchestrator_worker',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
          {
            id: 'conv_ops_worker',
            participants: [{ agentName: 'ops' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:01:00.000Z',
          },
        ]),
        messages: vi.fn(async (conversationId: string) => {
          if (conversationId === 'conv_orchestrator_worker') {
            return [
              {
                id: 'msg_wrong',
                agentName: 'WorkerA',
                text: 'orchestrator transcript',
                createdAt: '2026-02-20T12:00:01.000Z',
              },
            ];
          }
          return [
            {
              id: 'msg_right',
              agentName: 'WorkerA',
              text: 'ops transcript',
              createdAt: '2026-02-20T12:01:01.000Z',
            },
          ];
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--as', 'ops']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(1);
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith(
      'conv_ops_worker',
      expect.objectContaining({ limit: expect.any(Number) })
    );
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:01:01.000Z] WorkerA: ops transcript');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('orchestrator transcript'));
  });

  it('replies --unread filters by unread and does not flip read state', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 1,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'already seen',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: false,
          },
          {
            id: 'msg_2',
            agentName: 'WorkerA',
            text: 'needs attention',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--unread']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:00:02.000Z] WorkerA: needs attention');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('already seen'));
  });

  it('replies --unread with zero unread and no unread flags prints nothing', async () => {
    // Regression: unreadCount 0 + no per-message unread flags made
    // `messages.slice(-0)` === `slice(0)` and printed the ENTIRE read history.
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'already read one',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
          {
            id: 'msg_2',
            agentName: 'WorkerA',
            text: 'already read two',
            createdAt: '2026-02-20T12:00:02.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--unread']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('No messages found.');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('already read one'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('already read two'));
  });

  it('replies --unread distinguishes unknown unread state from no unread messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'recent inbound with unknown read state',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--unread']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('Unread state unavailable — showing recent inbound messages.');
    expect(deps.log).toHaveBeenCalledWith(
      '[2026-02-20T12:00:01.000Z] WorkerA: recent inbound with unknown read state'
    );
    expect(deps.log).not.toHaveBeenCalledWith('No messages found.');
  });

  it('replies --unread suppresses count fallback when messages are explicitly read', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 2,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'explicitly read one',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: false,
          },
          {
            id: 'msg_2',
            agentName: 'WorkerA',
            text: 'explicitly read two',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: false,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--unread']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('No messages found.');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('explicitly read'));
  });

  it('replies --unread falls back to unread_count for real SDK-shaped DMs without per-message read flags', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 2,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'real sdk shape one',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
          {
            id: 'msg_2',
            agentName: 'WorkerA',
            text: 'real sdk shape two',
            createdAt: '2026-02-20T12:00:02.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--unread', '--json']);

    expect(exitCode).toBeUndefined();
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual([
      expect.objectContaining({ id: 'msg_1', text: 'real sdk shape one' }),
      expect.objectContaining({ id: 'msg_2', text: 'real sdk shape two' }),
    ]);
  });

  it('replies --unread --json with zero unread emits an empty array', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'already read',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--unread', '--json']);

    expect(exitCode).toBeUndefined();
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual([]);
  });

  it('replies does not register unsupported --mark-read option', async () => {
    const relaycastClient = createRelaycastClientMock();
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--mark-read']);

    expect(exitCode).toBe(1);
    expect(deps.createRelaycastClient).not.toHaveBeenCalled();
  });

  it('replies renders messages with missing text instead of exiting 1', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            createdAt: '2026-02-20T12:00:01.000Z',
          } as any,
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:00:01.000Z] WorkerA: ');
    expect(deps.exit).not.toHaveBeenCalled();
  });

  it('replies keeps messages with missing sender or timestamp metadata visible', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'missing_sender',
            text: 'sender missing',
            createdAt: '2026-02-20T12:00:01.000Z',
          } as any,
          {
            id: 'missing_time',
            agentName: 'WorkerA',
            text: 'timestamp missing',
          } as any,
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('[1970-01-01T00:00:00.000Z] WorkerA: timestamp missing');
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:00:01.000Z] WorkerA: sender missing');
    expect(deps.log).not.toHaveBeenCalledWith('No messages found.');
  });

  it('history --to keeps messages with missing sender or timestamp metadata visible', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'missing_sender',
            text: 'sender missing',
            createdAt: '2026-02-20T12:00:01.000Z',
          } as any,
          {
            id: 'missing_time',
            agentName: 'WorkerA',
            text: 'timestamp missing',
          } as any,
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--to', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('[1970-01-01T00:00:00.000Z] WorkerA: timestamp missing');
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:00:01.000Z] WorkerA: sender missing');
    expect(deps.log).not.toHaveBeenCalledWith('No messages found.');
  });

  it('replies applies the display limit after filtering outbound raw messages', async () => {
    const rawMessages = [
      {
        id: 'msg_inbound',
        agentName: 'WorkerA',
        text: 'reply before echo',
        createdAt: '2026-02-20T12:00:01.000Z',
      },
      {
        id: 'msg_outbound',
        agentName: 'orchestrator',
        text: 'operator echo',
        createdAt: '2026-02-20T12:00:02.000Z',
      },
    ];
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async (_conversationId: string, opts?: { limit?: number }) =>
          rawMessages.slice(-(opts?.limit ?? rawMessages.length))
        ),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '-n', '1']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_1', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:00:01.000Z] WorkerA: reply before echo');
    expect(deps.log).not.toHaveBeenCalledWith('No messages found.');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('operator echo'));
  });

  it('replies clamps excessive limits before fetching DM history', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => []),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--limit', '100000000']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_1', { limit: 1000 });
  });

  it.each(['1e9', 'abc', '-5', '0'])('rejects invalid --limit value %s', async (limit) => {
    const { program, deps, relaycastClient } = createHarness();

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--limit', limit]);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(`Invalid --limit value: ${limit}`);
    expect(relaycastClient.dms.conversations).not.toHaveBeenCalled();
  });

  it('replies clamps excessive unread counts before fetching DM history', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 1_000_000_000,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => []),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--unread']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_1', { limit: 1000 });
  });

  it('replies exits 0 with friendly message when no conversation exists', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('No DM conversation with WorkerA.');
  });

  it('replies exits 1 when the relaycast client cannot be initialized', async () => {
    const { program, deps } = createHarness({
      createRelaycastError: new Error('auth failed'),
    });

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to initialize relaycast client: auth failed');
  });

  it('replies exits 1 when fetching the DM transcript fails', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => {
          throw new Error('\x1b]0;x\x07transcript unavailable');
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to fetch replies for WorkerA: transcript unavailable');
    expect(deps.error).not.toHaveBeenCalledWith(expect.stringContaining('\x1b'));
    expect(deps.error).not.toHaveBeenCalledWith(expect.stringContaining('\x07'));
  });

  it('replies --since 1h filters by parsed duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-20T13:00:00.000Z'));
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_old',
            agentName: 'WorkerA',
            text: 'too old',
            createdAt: '2026-02-20T11:59:59.000Z',
          },
          {
            id: 'msg_recent',
            agentName: 'WorkerA',
            text: 'inside window',
            createdAt: '2026-02-20T12:30:00.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--since', '1h']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:30:00.000Z] WorkerA: inside window');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('too old'));
  });

  it('replies rejects invalid --since before fetching messages', async () => {
    const relaycastClient = createRelaycastClientMock();
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--since', 'not a time']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Invalid --since value: not a time');
    expect(deps.createRelaycastClient).not.toHaveBeenCalled();
  });

  it('replies --as rejects unauthorized read identities before creating a client', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--as', 'ops']);

    expect(exitCode).toBe(1);
    expect(deps.createRelaycastClient).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      'Refusing to read as ops: read identities must be the configured orchestrator or listed in AGENT_RELAY_ALLOWED_READ_IDENTITIES.'
    );
  });

  it('replies --as allows configured read identities', async () => {
    vi.stubEnv('AGENT_RELAY_ALLOWED_READ_IDENTITIES', 'ops');
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--as', 'ops']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'ops',
      cwd: '/tmp/project',
    });
  });

  it('replies --as defaults to $AGENT_RELAY_ORCHESTRATOR_NAME when set', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_NAME', 'ops');
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'ops',
      cwd: '/tmp/project',
    });
  });

  it('replies --as falls back to "orchestrator" when env unset', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['replies', 'WorkerA']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'orchestrator',
      cwd: '/tmp/project',
    });
  });

  it('replies --json includes direction: "inbound" on inbound messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'json inbound',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['replies', 'WorkerA', '--json']);

    expect(exitCode).toBeUndefined();
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual([
      expect.objectContaining({
        id: 'msg_1',
        from: 'WorkerA',
        text: 'json inbound',
        createdAt: '2026-02-20T12:00:01.000Z',
        direction: 'inbound',
      }),
    ]);
  });

  it('sanitizes terminal controls in text mode while preserving JSON payloads', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'WorkerA' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'before\x1b]52;c;YWJj\x07\x1b[2Jold\roverwrite',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
        ]),
      },
    });
    const textHarness = createHarness({ relaycastClient });

    const textExitCode = await runCommand(textHarness.program, ['replies', 'WorkerA']);

    expect(textExitCode).toBeUndefined();
    expect(textHarness.deps.log).toHaveBeenCalledWith(
      '[2026-02-20T12:00:01.000Z] WorkerA: beforeoldoverwrite'
    );
    expect(textHarness.deps.log).not.toHaveBeenCalledWith(expect.stringContaining('\x1b'));
    expect(textHarness.deps.log).not.toHaveBeenCalledWith(expect.stringContaining('\r'));

    const jsonHarness = createHarness({ relaycastClient });
    const jsonExitCode = await runCommand(jsonHarness.program, ['replies', 'WorkerA', '--json']);

    expect(jsonExitCode).toBeUndefined();
    expect(JSON.parse((jsonHarness.deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual(
      [expect.objectContaining({ text: 'before\x1b]52;c;YWJj\x07\x1b[2Jold\roverwrite' })]
    );
  });

  it('inbox text renderer uses the registered reader in unread DM headers', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 3,
            lastMessage: {
              id: 'm3',
              text: 'third',
              createdAt: '2026-02-20T12:00:03.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'first',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'Worker2',
            text: 'second',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
          {
            id: 'm3',
            agentName: 'Worker2',
            text: 'third',
            createdAt: '2026-02-20T12:00:03.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: '__cli_inbox__',
      cwd: '/tmp/project',
    });
    expect(deps.log).toHaveBeenCalledWith('  Worker2 → __cli_inbox__ (3 unread):');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:03.000Z] Worker2: third');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:02.000Z] Worker2: second');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: first');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('more'));
  });

  it('inbox text renderer prints only the three most recent messages and appends spec overflow footer', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 5,
            lastMessage: {
              id: 'm5',
              text: 'fifth',
              createdAt: '2026-02-20T12:00:05.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'first',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'Worker2',
            text: 'second',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
          {
            id: 'm3',
            agentName: 'Worker2',
            text: 'third',
            createdAt: '2026-02-20T12:00:03.000Z',
            unread: true,
          },
          {
            id: 'm4',
            agentName: 'Worker2',
            text: 'fourth',
            createdAt: '2026-02-20T12:00:04.000Z',
            unread: true,
          },
          {
            id: 'm5',
            agentName: 'Worker2',
            text: 'fifth',
            createdAt: '2026-02-20T12:00:05.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:05.000Z] Worker2: fifth');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:04.000Z] Worker2: fourth');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:03.000Z] Worker2: third');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('second'));
    expect(deps.log).toHaveBeenCalledWith(
      "    … (2 more — run `agent-relay replies 'Worker2' --unread` to see all)"
    );
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('... (2 more - run'));
  });

  it('inbox text renderer uses --agent value as the reader in unread DM headers', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_NAME', 'ops');
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm1',
              text: 'ops-only update',
              createdAt: '2026-02-20T12:00:01.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'ops-only update',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--agent', 'ops']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('  Worker2 → ops (1 unread):');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: ops-only update');
  });

  it('inbox text renderer filters outbound echoes when sender information is present', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 2,
            lastMessage: {
              id: 'm2',
              text: 'outbound response',
              createdAt: '2026-02-20T12:00:02.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'actual worker reply',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'orchestrator',
            text: 'outbound response',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: actual worker reply');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('outbound response'));
  });

  it('inbox text renderer fetches message fallback only when inbox omits DM messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: null,
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'fetched fallback reply',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'orchestrator',
            text: 'fetched outbound response',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 10 });
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: fetched fallback reply');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('fetched outbound response'));
  });

  it('inbox text renderer fetches DM messages when last_message lacks sender metadata', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm1',
              text: 'fetched reply',
              createdAt: '2026-02-20T12:00:01.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'fetched reply',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 10 });
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: fetched reply');
  });

  it('inbox text renderer does not fetch DM messages when unread count is zero', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 0,
            lastMessage: null,
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => {
          throw new Error('fallback should not run');
        }),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).not.toHaveBeenCalled();
  });

  it('inbox text renderer prints overflow footer when embedded count equals visible limit', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 10,
            lastMessage: {
              id: 'm3',
              text: 'third',
              createdAt: '2026-02-20T12:00:03.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'first',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'Worker2',
            text: 'second',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
          {
            id: 'm3',
            agentName: 'Worker2',
            text: 'third',
            createdAt: '2026-02-20T12:00:03.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      "    … (7 more — run `agent-relay replies 'Worker2' --unread` to see all)"
    );
  });

  it('inbox text renderer emits a sanitized fallback line when unread body fetch fails', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: "Worker\x1b[31m'2",
            unreadCount: 2,
            lastMessage: null,
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => {
          throw new Error('network down');
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    // eslint-disable-next-line no-control-regex -- asserting output contains no raw escape/bell bytes
    expect(logged.join('\n')).not.toMatch(/[\x1b\x07]/);
    expect(deps.log).toHaveBeenCalledWith(
      "    (could not load message bodies — run `agent-relay replies 'Worker'\\''2' --unread`)"
    );
  });

  it('inbox bounds preview fetches despite excessive unread counts', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1_000_000_000,
            lastMessage: null,
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 10 });
  });

  it('inbox footer shell-quotes untrusted agent names in suggested commands', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'worker; touch /tmp/pwn',
            unreadCount: 4,
            lastMessage: {
              id: 'm3',
              text: 'third',
              createdAt: '2026-02-20T12:00:03.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'worker; touch /tmp/pwn',
            text: 'first',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'worker; touch /tmp/pwn',
            text: 'second',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
          {
            id: 'm3',
            agentName: 'worker; touch /tmp/pwn',
            text: 'third',
            createdAt: '2026-02-20T12:00:03.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      "    … (1 more — run `agent-relay replies 'worker; touch /tmp/pwn' --unread` to see all)"
    );
  });

  it('inbox DM renderer falls back to unread_count for SDK-shaped messages without read flags', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 2,
            lastMessage: null,
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'oldest sdk-shaped message',
            createdAt: '2026-02-20T12:00:01.000Z',
          },
          {
            id: 'm2',
            agentName: 'Worker2',
            text: 'newer sdk-shaped message',
            createdAt: '2026-02-20T12:00:02.000Z',
          },
          {
            id: 'm3',
            agentName: 'Worker2',
            text: 'newest sdk-shaped message',
            createdAt: '2026-02-20T12:00:03.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(
      '    [2026-02-20T12:00:03.000Z] Worker2: newest sdk-shaped message'
    );
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:02.000Z] Worker2: newer sdk-shaped message');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('oldest sdk-shaped message'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('more'));
  });

  it('inbox text renderer fetches fallback when lastMessage is only an outbound echo', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm2',
              agentName: 'orchestrator',
              text: 'outbound echo',
              createdAt: '2026-02-20T12:00:02.000Z',
              direction: 'outbound',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'actual worker reply',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'orchestrator',
            text: 'outbound echo',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 10 });
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: actual worker reply');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('outbound echo'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('1 more'));
  });

  it('inbox text renderer does not attribute real-shape last_message with unknown sender to the worker', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm2',
              text: 'operator echo',
              createdAt: '2026-02-20T12:00:02.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm2',
            agentName: '__cli_inbox__',
            text: 'operator echo',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 10 });
    expect(deps.log).not.toHaveBeenCalledWith('    [2026-02-20T12:00:02.000Z] Worker2: operator echo');
    expect(deps.log).toHaveBeenCalledWith(
      "    … (1 more — run `agent-relay replies 'Worker2' --unread` to see all)"
    );
  });

  it('inbox text renderer fetches enough fallback messages past newer outbound echoes', async () => {
    const conversationMessages = [
      {
        id: 'm4',
        agentName: 'orchestrator',
        text: 'newer outbound echo 3',
        createdAt: '2026-02-20T12:00:04.000Z',
        unread: true,
      },
      {
        id: 'm3',
        agentName: 'orchestrator',
        text: 'newer outbound echo 2',
        createdAt: '2026-02-20T12:00:03.000Z',
        unread: true,
      },
      {
        id: 'm2',
        agentName: 'orchestrator',
        text: 'newer outbound echo 1',
        createdAt: '2026-02-20T12:00:02.000Z',
        unread: true,
      },
      {
        id: 'm1',
        agentName: 'Worker2',
        text: 'worker reply hidden behind outbound echoes',
        createdAt: '2026-02-20T12:00:01.000Z',
        unread: true,
      },
    ];
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm4',
              agentName: 'orchestrator',
              text: 'newer outbound echo 3',
              createdAt: '2026-02-20T12:00:04.000Z',
              direction: 'outbound',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async (_conversationId: string, opts?: { limit?: number }) =>
          conversationMessages.slice(0, opts?.limit ?? conversationMessages.length)
        ),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 10 });
    expect(deps.log).toHaveBeenCalledWith(
      '    [2026-02-20T12:00:01.000Z] Worker2: worker reply hidden behind outbound echoes'
    );
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('newer outbound echo'));
    expect(deps.log).not.toHaveBeenCalledWith(
      expect.stringContaining("run `agent-relay replies 'Worker2' --unread`")
    );
  });

  it('inbox text renderer deduplicates overlapping embedded and fetched unread DM messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 2,
            lastMessage: {
              id: 'm1',
              text: 'overlap once',
              createdAt: '2026-02-20T12:00:01.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'overlap once',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'Worker2',
            text: 'newer fetched',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    expect(logged.filter((line) => line.includes('overlap once'))).toHaveLength(1);
    expect(logged.findIndex((line) => line.includes('newer fetched'))).toBeLessThan(
      logged.findIndex((line) => line.includes('overlap once'))
    );
  });

  it('inbox text renderer sanitizes untrusted summary fields before logging', async () => {
    vi.stubEnv('AGENT_RELAY_ALLOWED_READ_IDENTITIES', 'ops\x1b]0;pwn\x07');
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadChannels: [{ channelName: 'gen\x1b[2Jeral', unreadCount: 2 }],
        mentions: [
          {
            id: 'mention_1',
            channelName: 'ops\rhidden',
            agentName: 'Lead\x1bM',
            text: 'please\x1b]0;pwn\x07 review',
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ],
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker\x1b[31m2',
            unreadCount: 4,
            lastMessage: {
              id: 'm3',
              text: 'third',
              createdAt: '2026-02-20T12:00:03.000Z',
            },
          },
        ],
        recentReactions: [
          {
            messageId: 'msg_1',
            channelName: 'react\x9bDions',
            emoji: 'eyes\x1b[0m',
            agentName: 'Reviewer\rX',
            createdAt: '2026-02-20T12:02:00.000Z',
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker\x1b[31m2',
            text: 'first',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'Worker\x1b[31m2',
            text: 'second',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
          {
            id: 'm3',
            agentName: 'Worker\x1b[31m2',
            text: 'third',
            createdAt: '2026-02-20T12:00:03.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--agent', 'ops\x1b]0;pwn\x07']);

    expect(exitCode).toBeUndefined();
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    // eslint-disable-next-line no-control-regex -- asserting output contains no raw escape/CSI bytes
    expect(logged.join('\n')).not.toMatch(/[\x1b\r\x9b]/);
    expect(logged).toContain('  #general: 2');
    expect(logged).toContain('  [2026-02-20T12:00:00.000Z] #ops hidden @Lead: please review');
    expect(logged).toContain('  Worker2 → ops (4 unread):');
    expect(logged).toContain("    … (1 more — run `agent-relay replies 'Worker2' --unread` to see all)");
    expect(logged).toContain('  [2026-02-20T12:02:00.000Z] #reactions eyes by @Reviewer X');
  });

  it('inbox text renderer keeps untrusted scalar fields on one sanitized line', async () => {
    vi.stubEnv('AGENT_RELAY_ALLOWED_READ_IDENTITIES', 'ops\nroot');
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadChannels: [{ channelName: 'ops\n[fake-channel]', unreadCount: 1 }],
        mentions: [
          {
            id: 'mention_1',
            channelName: 'general',
            agentName: 'Lead\n[2099] root',
            text: 'approve\tthis',
            createdAt: '2026-02-20T12:00:00.000Z',
          },
        ],
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker\n[2099] APPROVED',
            unreadCount: 1,
            lastMessage: null,
          },
        ],
        recentReactions: [],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker\n[2099] APPROVED',
            text: 'real body',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--agent', 'ops\nroot']);

    expect(exitCode).toBeUndefined();
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    expect(logged).toContain('  #ops [fake-channel]: 1');
    expect(logged).toContain('  [2026-02-20T12:00:00.000Z] #general @Lead [2099] root: approve this');
    expect(logged).toContain('  Worker [2099] APPROVED → ops root (1 unread):');
    expect(logged).toContain('    [2026-02-20T12:00:01.000Z] Worker [2099] APPROVED: real body');
    expect(logged.every((line) => !/[\r\n\t]/.test(line))).toBe(true);
    expect(logged.join('\n')).not.toMatch(/^\[2099\] APPROVED$/m);
  });

  it('inbox bounds concurrent fallback DM body fetches', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const unreadDms = Array.from({ length: 20 }, (_, index) => ({
      conversationId: `dm_${index}`,
      from: `Worker${index}`,
      unreadCount: 1,
      lastMessage: null,
    }));
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({ unreadDms })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async (conversationId: string) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          const worker = `Worker${conversationId.split('_')[1]}`;
          return [
            {
              id: `${conversationId}_msg`,
              agentName: worker,
              text: `${worker} body`,
              createdAt: '2026-02-20T12:00:01.000Z',
              unread: true,
            },
          ];
        }),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(20);
    expect(maxInFlight).toBeLessThanOrEqual(8);
  });

  it('inbox caps fallback DM body fetches to the first 50 unread conversations', async () => {
    const unreadDms = Array.from({ length: 60 }, (_, index) => ({
      conversationId: `dm_${index}`,
      from: `Worker${index}`,
      unreadCount: 1,
      lastMessage: {
        id: `last_${index}`,
        text: `summary ${index}`,
        createdAt: '2026-02-20T12:00:01.000Z',
      },
    }));
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({ unreadDms })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async (conversationId: string) => {
          const worker = `Worker${conversationId.split('_')[1]}`;
          return [
            {
              id: `${conversationId}_msg`,
              agentName: worker,
              text: `${worker} body`,
              createdAt: '2026-02-20T12:00:01.000Z',
              unread: true,
            },
          ];
        }),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(50);
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_49', { limit: 10 });
    expect(relaycastClient.dms.messages).not.toHaveBeenCalledWith('dm_50', expect.anything());
  });

  it('inbox --json fetches selected unread DM bodies instead of reporting outbound echoes', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm2',
              agentName: 'orchestrator',
              text: 'outbound echo',
              createdAt: '2026-02-20T12:00:02.000Z',
              direction: 'outbound',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => [
          {
            id: 'm1',
            agentName: 'Worker2',
            text: 'actual unread body',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'm2',
            agentName: 'orchestrator',
            text: 'outbound echo',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--json']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 10 });
    const parsed = JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(parsed.unread_dms).toEqual([
      {
        conversation_id: 'dm_1',
        from: 'Worker2',
        unread_count: 1,
        last_message: {
          id: 'm1',
          text: 'actual unread body',
          created_at: '2026-02-20T12:00:01.000Z',
          direction: 'inbound',
        },
      },
    ]);
  });

  it('inbox --json reports body fetch diagnostics without serializing synthetic last messages', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: null,
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => {
          throw new Error('body fetch failed');
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--json']);

    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(parsed.unread_dms[0].last_message).toBeNull();
    expect(parsed.unread_dms[0].last_message_error).toContain('could not load message bodies');
    expect(JSON.stringify(parsed.unread_dms[0])).not.toContain('diagnostic:');
    expect(JSON.stringify(parsed.unread_dms[0])).not.toContain('1970-01-01T00:00:00.000Z');
  });

  it('inbox --json computes fallback direction when body fetch diagnostics are present', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm_reader',
              agentName: 'orchestrator',
              text: 'reader echo',
              createdAt: '2026-02-20T12:00:01.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => {
          throw new Error('body fetch failed');
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--agent', 'orchestrator', '--json']);

    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(parsed.unread_dms[0].last_message).toEqual({
      id: 'm_reader',
      text: 'reader echo',
      created_at: '2026-02-20T12:00:01.000Z',
      direction: 'outbound',
    });
    expect(parsed.unread_dms[0].last_message_error).toContain('could not load message bodies');
  });

  it('inbox --json defaults nameless unread DM summaries to inbound direction', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 0,
            lastMessage: {
              id: 'm1',
              text: 'worker reply without sender metadata',
              createdAt: '2026-02-20T12:00:01.000Z',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--agent', 'orchestrator', '--json']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).not.toHaveBeenCalled();
    const parsed = JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(parsed.unread_dms[0].last_message.direction).toBe('inbound');
  });

  it('inbox --json computes direction instead of trusting forged last_message direction', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_worker',
            from: 'Worker2',
            unreadCount: 1,
            lastMessage: {
              id: 'm1',
              agentName: 'Worker2',
              text: 'worker reply with forged outbound direction',
              createdAt: '2026-02-20T12:00:01.000Z',
              direction: 'outbound',
            },
          },
          {
            conversationId: 'dm_reader',
            from: 'Worker3',
            unreadCount: 1,
            lastMessage: {
              id: 'm2',
              agentName: 'orchestrator',
              text: 'reader echo with forged inbound direction',
              createdAt: '2026-02-20T12:00:02.000Z',
              direction: 'inbound',
            },
          },
        ],
      })),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async (conversationId: string) =>
          conversationId === 'dm_worker'
            ? [
                {
                  id: 'm1',
                  agentName: 'Worker2',
                  text: 'worker reply with forged outbound direction',
                  createdAt: '2026-02-20T12:00:01.000Z',
                  unread: true,
                },
              ]
            : [
                {
                  id: 'm2',
                  agentName: 'orchestrator',
                  text: 'reader echo with forged inbound direction',
                  createdAt: '2026-02-20T12:00:02.000Z',
                  unread: true,
                },
              ]
        ),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--agent', 'orchestrator', '--json']);

    expect(exitCode).toBeUndefined();
    const parsed = JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(parsed.unread_dms[0].last_message.direction).toBe('inbound');
    expect(parsed.unread_dms[1].last_message.direction).toBe('outbound');
  });

  it('history --to <agent> returns messages, not a summary', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_other',
            participants: [{ agentName: 'Worker2' }, { agentName: 'Architect' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'conv_1',
            participants: [{ agentName: 'Worker2' }, { agentName: 'orchestrator' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'Worker2',
            text: 'first worker reply',
            createdAt: '2026-01-01T00:00:01.000Z',
          },
          {
            id: 'msg_2',
            agentName: 'orchestrator',
            text: 'operator response',
            createdAt: '2026-01-01T00:00:02.000Z',
          },
          {
            id: 'msg_3',
            agentName: 'Worker2',
            text: 'second worker reply',
            createdAt: '2026-01-01T00:00:03.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--to', 'Worker2']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'orchestrator',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_1', { limit: 50 });
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('DM conversations for'));
    expect(deps.log).toHaveBeenNthCalledWith(1, '[2026-01-01T00:00:01.000Z] Worker2: first worker reply');
    expect(deps.log).toHaveBeenNthCalledWith(2, '[2026-01-01T00:00:02.000Z] orchestrator: operator response');
    expect(deps.log).toHaveBeenNthCalledWith(3, '[2026-01-01T00:00:03.000Z] Worker2: second worker reply');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('→ orchestrator'));
  });

  it('history --to sanitizes terminal controls in DM history errors', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'Worker2' }, { agentName: 'orchestrator' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => {
          throw new Error('\x1b]0;x\x07history unavailable');
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--to', 'Worker2']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to fetch DM history: history unavailable');
    expect(deps.error).not.toHaveBeenCalledWith(expect.stringContaining('\x1b'));
    expect(deps.error).not.toHaveBeenCalledWith(expect.stringContaining('\x07'));
  });

  it('history --to <agent> selects the 1:1 conversation before a group DM with the same agent', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_group',
            dm_type: 'group',
            participants: [
              { agentName: 'orchestrator' },
              { agentName: 'Worker2' },
              { agentName: 'Architect' },
            ],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'conv_direct',
            dm_type: '1:1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'Worker2' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:01:00.000Z',
          },
        ]),
        messages: vi.fn(async (conversationId: string) => {
          if (conversationId === 'conv_group') {
            return [
              {
                id: 'msg_group',
                agentName: 'Worker2',
                text: 'group-only history',
                createdAt: '2026-01-01T00:00:01.000Z',
              },
            ];
          }
          return [
            {
              id: 'msg_direct',
              agentName: 'Worker2',
              text: 'direct history',
              createdAt: '2026-01-01T00:01:01.000Z',
            },
          ];
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--to', 'Worker2']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(1);
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_direct', { limit: 50 });
    expect(deps.log).toHaveBeenCalledWith('[2026-01-01T00:01:01.000Z] Worker2: direct history');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('group-only history'));
  });

  it('history --to <agent> --json adds direction field', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'Worker2' }, { agentName: 'orchestrator' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'Worker2',
            text: 'worker reply',
            createdAt: '2026-01-01T00:00:01.000Z',
          },
          {
            id: 'msg_2',
            agentName: 'orchestrator',
            text: 'operator response',
            createdAt: '2026-01-01T00:00:02.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--to', 'Worker2', '--json']);

    expect(exitCode).toBeUndefined();
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual([
      {
        id: 'msg_1',
        from: 'Worker2',
        to: 'orchestrator',
        text: 'worker reply',
        createdAt: '2026-01-01T00:00:01.000Z',
        direction: 'inbound',
      },
      {
        id: 'msg_2',
        from: 'orchestrator',
        to: 'Worker2',
        text: 'operator response',
        createdAt: '2026-01-01T00:00:02.000Z',
        direction: 'outbound',
      },
    ]);
  });

  it('history --to agent --from same agent shows only that agent in the orchestrator thread', async () => {
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_other',
            participants: [{ agentName: 'Worker2' }, { agentName: 'Architect' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'Worker2' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_1',
            agentName: 'Worker2',
            text: 'hello from worker',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'msg_2',
            agentName: 'orchestrator',
            text: 'operator echo',
            createdAt: '2026-01-01T00:00:01.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--to', 'Worker2', '--from', 'Worker2']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'orchestrator',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_1', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('[2026-01-01T00:00:00.000Z] Worker2: hello from worker');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('operator echo'));
  });

  it('history --to agent --from agent applies display limit after sender filtering', async () => {
    const rawMessages = [
      {
        id: 'msg_worker',
        agentName: 'Worker2',
        text: 'worker reply before echo',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
      {
        id: 'msg_orchestrator',
        agentName: 'orchestrator',
        text: 'operator echo',
        createdAt: '2026-01-01T00:00:02.000Z',
      },
    ];
    const relaycastClient = createRelaycastClientMock({
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'orchestrator' }, { agentName: 'Worker2' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
        messages: vi.fn(async (_conversationId: string, opts?: { limit?: number }) =>
          rawMessages.slice(-(opts?.limit ?? rawMessages.length))
        ),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, [
      'history',
      '--to',
      'Worker2',
      '--from',
      'Worker2',
      '-n',
      '1',
    ]);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_1', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('[2026-01-01T00:00:01.000Z] Worker2: worker reply before echo');
    expect(deps.log).not.toHaveBeenCalledWith('No messages found.');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('operator echo'));
  });

  it('history --to agent --from other logs clear message when no conversation exists', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['history', '--to', 'alice', '--from', 'nobody']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('No DM conversation found between orchestrator and alice.');
  });

  it('history --from agent shows channel messages from that agent', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        {
          id: 'msg_1',
          agent_name: 'relay',
          text: 'hello from relay',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ]),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('hello from relay'));
  });

  it('history --from agent keeps the newest channel messages in chronological order', async () => {
    // Feed returned out of order to prove the --from branch re-sorts and
    // keeps the most recent `limit` (regression: it used to slice(0, limit)
    // off the raw feed, silently keeping the OLDEST messages).
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        { id: 'm3', agent_name: 'relay', text: 'third', created_at: '2026-02-20T11:00:03.000Z' },
        { id: 'm1', agent_name: 'relay', text: 'first', created_at: '2026-02-20T11:00:01.000Z' },
        { id: 'm2', agent_name: 'relay', text: 'second', created_at: '2026-02-20T11:00:02.000Z' },
      ]),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--limit', '2']);

    expect(exitCode).toBeUndefined();
    const lines = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    const idx2 = lines.findIndex((l) => l.includes('second'));
    const idx3 = lines.findIndex((l) => l.includes('third'));
    expect(lines.some((l) => l.includes('first'))).toBe(false); // oldest dropped
    expect(idx2).toBeGreaterThanOrEqual(0);
    expect(idx3).toBeGreaterThan(idx2); // chronological
  });

  it('history --from agent keeps newest channel messages when more than limit are returned out of order', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => [
        { id: 'm4', agent_name: 'relay', text: 'fourth', created_at: '2026-02-20T11:00:04.000Z' },
        { id: 'm1', agent_name: 'relay', text: 'first', created_at: '2026-02-20T11:00:01.000Z' },
        { id: 'm3', agent_name: 'relay', text: 'third', created_at: '2026-02-20T11:00:03.000Z' },
        { id: 'm2', agent_name: 'relay', text: 'second', created_at: '2026-02-20T11:00:02.000Z' },
      ]),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--limit', '2']);

    expect(exitCode).toBeUndefined();
    const lines = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(lines.some((l) => l.includes('first') || l.includes('second'))).toBe(false);
    expect(lines[0]).toContain('third');
    expect(lines[1]).toContain('fourth');
  });

  it('history --from agent shows DM messages sent by that agent', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => []),
      dms: {
        conversations: vi.fn(async () => [
          {
            id: 'conv_1',
            participants: [{ agentName: 'relay' }, { agentName: 'architect' }],
            lastMessage: null,
            unreadCount: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ]),
        messages: vi.fn(async () => [
          {
            id: 'msg_dm_1',
            agentName: 'relay',
            text: 'hey architect',
            createdAt: '2026-01-01T01:00:00.000Z',
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'relay' }));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('hey architect'));
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('(DM)'));
  });

  it('history --from reuses and disconnects a single relaycast client', async () => {
    const relaycastClient = createRelaycastClientMock({
      disconnect: vi.fn(async () => undefined),
      messages: vi.fn(async () => []),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledTimes(1);
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'relay',
      cwd: '/tmp/project',
    });
    expect(relaycastClient.disconnect).toHaveBeenCalledTimes(1);
  });

  it('history --from agent scans conversations beyond the first ten', async () => {
    const conversations = Array.from({ length: 11 }, (_, index) => ({
      id: `conv_${index + 1}`,
      participants: [{ agentName: 'relay' }, { agentName: `agent_${index + 1}` }],
      lastMessage: null,
      unreadCount: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => []),
      dms: {
        conversations: vi.fn(async () => conversations),
        messages: vi.fn(async (conversationId: string) =>
          conversationId === 'conv_11'
            ? [
                {
                  id: 'msg_dm_11',
                  agentName: 'relay',
                  text: 'eleventh conversation reply',
                  createdAt: '2026-01-01T01:00:00.000Z',
                },
              ]
            : []
        ),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(11);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('eleventh conversation reply'));
  });

  it('history --from agent caps DM conversation scans for large inboxes', async () => {
    const conversations = Array.from({ length: 75 }, (_, index) => ({
      id: `conv_${index + 1}`,
      participants: [{ agentName: 'relay' }, { agentName: `agent_${index + 1}` }],
      lastMessage: null,
      unreadCount: 0,
      createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString(),
    }));
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => []),
      dms: {
        conversations: vi.fn(async () => conversations),
        messages: vi.fn(async () => []),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(50);
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_75', { limit: 50 });
    expect(relaycastClient.dms.messages).not.toHaveBeenCalledWith('conv_25', expect.anything());
  });

  it('history --from agent fetches the full requested limit per scanned DM conversation', async () => {
    const activeMessages = Array.from({ length: 50 }, (_, index) => ({
      id: `active_${index}`,
      agentName: 'relay',
      text: `active message ${index}`,
      createdAt: `2026-01-01T01:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const conversations = Array.from({ length: 5 }, (_, index) => ({
      id: index === 0 ? 'conv_active' : `conv_${index}`,
      participants: [{ agentName: 'relay' }, { agentName: `agent_${index}` }],
      lastMessage: null,
      unreadCount: 0,
      createdAt: index === 0 ? '2026-01-01T02:00:00.000Z' : `2026-01-01T00:0${index}:00.000Z`,
    }));
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => []),
      dms: {
        conversations: vi.fn(async () => conversations),
        messages: vi.fn(async (conversationId: string, opts?: { limit?: number }) =>
          conversationId === 'conv_active' ? activeMessages.slice(0, opts?.limit ?? 0) : []
        ),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--limit', '50']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_active', { limit: 50 });
    const logged = (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
    expect(logged).toHaveLength(50);
    expect(logged[0]).toContain('active message 0');
    expect(logged[49]).toContain('active message 49');
  });

  it('history --from agent bounds per-conversation fetches for large requested limits', async () => {
    const conversations = Array.from({ length: 50 }, (_, index) => ({
      id: `conv_${index}`,
      participants: [{ agentName: 'relay' }, { agentName: `agent_${index}` }],
      lastMessage: null,
      unreadCount: 0,
      createdAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index * 1000).toISOString(),
    }));
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => []),
      dms: {
        conversations: vi.fn(async () => conversations),
        messages: vi.fn(async () => []),
      },
    });
    const { program } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--limit', '1000']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledTimes(50);
    for (const call of (relaycastClient.dms.messages as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toEqual({ limit: 100 });
    }
    const totalFetchedLimit = (relaycastClient.dms.messages as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (sum, call) => sum + ((call[1] as { limit?: number } | undefined)?.limit ?? 0),
      0
    );
    expect(totalFetchedLimit).toBeLessThanOrEqual(5000);
  });

  it('history --from agent with no messages shows no messages found', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => []),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('No messages found.');
  });

  it('history --from exits non-zero when both channel and DM fetches fail', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => {
        throw new Error('channel down');
      }),
      dms: {
        conversations: vi.fn(async () => {
          throw new Error('dm down');
        }),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBe(1);
    expect(deps.log).not.toHaveBeenCalledWith('No messages found.');
    expect(deps.error).toHaveBeenCalledWith(
      'Failed to fetch history sources: channel: channel down; dm: dm down'
    );
  });

  it('history --from warns when one source fails even if the other is empty', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => {
        throw new Error('channel down');
      }),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay']);

    expect(exitCode).toBeUndefined();
    expect(deps.error).toHaveBeenCalledWith('Warning: partial history results; channel: channel down');
    expect(deps.log).toHaveBeenCalledWith('No messages found.');
  });

  it('history --from --json warns when one source fails even if the other is empty', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => {
        throw new Error('channel down');
      }),
      dms: {
        conversations: vi.fn(async () => []),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--json']);

    expect(exitCode).toBeUndefined();
    expect(deps.error).toHaveBeenCalledWith('Warning: partial history results; channel: channel down');
    expect(JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string)).toEqual([]);
  });

  it('history --from --json exits non-zero when both channel and DM fetches fail', async () => {
    const relaycastClient = createRelaycastClientMock({
      messages: vi.fn(async () => {
        throw new Error('channel down');
      }),
      dms: {
        conversations: vi.fn(async () => {
          throw new Error('dm down');
        }),
        messages: vi.fn(async () => []),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['history', '--from', 'relay', '--json']);

    expect(exitCode).toBe(1);
    expect(deps.log).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith(
      'Failed to fetch history sources: channel: channel down; dm: dm down'
    );
  });

  it('returns non-zero for missing required args', async () => {
    const { program, relaycastClient } = createHarness();

    const exitCode = await runCommand(program, ['send', 'WorkerOnly']);

    expect(exitCode).toBe(1);
    expect(relaycastClient.dm).not.toHaveBeenCalled();
  });

  it('handles broker unavailable errors', async () => {
    const { program, deps } = createHarness({
      createRelaycastError: new Error('broker unavailable'),
    });

    const exitCode = await runCommand(program, ['read', 'msg_broken']);

    expect(exitCode).toBe(1);
    expect(deps.error).toHaveBeenCalledWith('Failed to initialize relaycast client: broker unavailable');
  });
});
