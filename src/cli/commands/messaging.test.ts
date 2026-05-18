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
    markRead: vi.fn(async () => undefined),
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
            last_message: null,
            messages: [
              {
                id: 'dm_msg_1',
                text: 'Please check the latest patch.',
                created_at: '2026-02-20T12:01:00.000Z',
                direction: 'inbound',
              },
            ],
          },
        ],
        recent_reactions: [],
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
              direction: 'inbound',
            },
            messages: [
              {
                id: 'msg_1',
                text: 'hello',
                createdAt: '2026-02-20T12:01:00.000Z',
                direction: 'inbound',
              },
            ],
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
              agentName: 'Teammate',
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
              agentName: 'orchestrator',
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
              agentName: 'somebody',
              createdAt: '2026-02-20T12:04:00.000Z',
              direction: 'outbound',
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
            direction: 'outbound',
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
            direction: 'outbound',
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

  it('inbox --agent registers as the specified agent name', async () => {
    const { program, deps } = createHarness();

    const exitCode = await runCommand(program, ['inbox', '--agent', 'my-worker']);

    expect(exitCode).toBeUndefined();
    expect(deps.createRelaycastClient).toHaveBeenCalledWith({
      agentName: 'my-worker',
      cwd: '/tmp/project',
    });
  });

  it('replies <agent> returns only inbound messages', async () => {
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

  it('replies <agent> --as selects the conversation shared by the overridden reader and agent', async () => {
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
    expect(relaycastClient.markRead).not.toHaveBeenCalled();
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

  it('replies --mark-read flips read state after output only for printed messages', async () => {
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
            id: 'too_old',
            agentName: 'WorkerA',
            text: 'too old',
            createdAt: '2026-02-20T11:59:59.000Z',
            unread: true,
          },
          {
            id: 'msg_1',
            agentName: 'WorkerA',
            text: 'first printed',
            createdAt: '2026-02-20T12:00:01.000Z',
            unread: true,
          },
          {
            id: 'msg_2',
            agentName: 'WorkerA',
            text: 'second printed',
            createdAt: '2026-02-20T12:00:02.000Z',
            unread: true,
          },
          {
            id: 'read_later',
            agentName: 'WorkerA',
            text: 'read later',
            createdAt: '2026-02-20T12:00:03.000Z',
            unread: false,
          },
        ]),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, [
      'replies',
      'WorkerA',
      '--unread',
      '--mark-read',
      '--since',
      '2026-02-20T12:00:00.000Z',
      '-n',
      '1',
    ]);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('conv_1', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('[2026-02-20T12:00:02.000Z] WorkerA: second printed');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('too old'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('first printed'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('read later'));
    expect(relaycastClient.markRead).toHaveBeenCalledTimes(1);
    expect(relaycastClient.markRead).toHaveBeenCalledWith('msg_2');
    const logMock = deps.log as ReturnType<typeof vi.fn>;
    const markReadMock = relaycastClient.markRead as ReturnType<typeof vi.fn>;
    expect(logMock.mock.invocationCallOrder[0]).toBeLessThan(markReadMock.mock.invocationCallOrder[0]);
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

  it('replies --as <name> overrides the orchestrator identity', async () => {
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

  it('inbox text renderer uses the registered reader in unread DM headers', async () => {
    const relaycastClient = createRelaycastClientMock({
      inbox: vi.fn(async () => ({
        unreadDms: [
          {
            conversationId: 'dm_1',
            from: 'Worker2',
            unreadCount: 3,
            lastMessage: null,
            messages: [
              { id: 'm1', text: 'first', createdAt: '2026-02-20T12:00:01.000Z', direction: 'inbound' },
              { id: 'm2', text: 'second', createdAt: '2026-02-20T12:00:02.000Z', direction: 'inbound' },
              { id: 'm3', text: 'third', createdAt: '2026-02-20T12:00:03.000Z', direction: 'inbound' },
            ],
          },
        ],
      })),
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
            lastMessage: null,
            messages: [
              { id: 'm1', text: 'first', createdAt: '2026-02-20T12:00:01.000Z', direction: 'inbound' },
              { id: 'm2', text: 'second', createdAt: '2026-02-20T12:00:02.000Z', direction: 'inbound' },
              { id: 'm3', text: 'third', createdAt: '2026-02-20T12:00:03.000Z', direction: 'inbound' },
              { id: 'm4', text: 'fourth', createdAt: '2026-02-20T12:00:04.000Z', direction: 'inbound' },
              { id: 'm5', text: 'fifth', createdAt: '2026-02-20T12:00:05.000Z', direction: 'inbound' },
            ],
          },
        ],
      })),
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox']);

    expect(exitCode).toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:05.000Z] Worker2: fifth');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:04.000Z] Worker2: fourth');
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:03.000Z] Worker2: third');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('second'));
    expect(deps.log).toHaveBeenCalledWith(
      '    … (2 more — run `agent-relay replies Worker2 --unread` to see all)'
    );
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('... (2 more - run'));
  });

  it('inbox text renderer uses --agent value as the reader in unread DM headers', async () => {
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
              direction: 'inbound',
            },
          },
        ],
      })),
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
            lastMessage: null,
            messages: [
              {
                id: 'm1',
                agentName: 'Worker2',
                text: 'actual worker reply',
                createdAt: '2026-02-20T12:00:01.000Z',
                direction: 'inbound',
              },
              {
                id: 'm2',
                agentName: 'orchestrator',
                text: 'outbound response',
                createdAt: '2026-02-20T12:00:02.000Z',
                direction: 'outbound',
              },
            ],
          },
        ],
      })),
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
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: fetched fallback reply');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('fetched outbound response'));
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
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith('    [2026-02-20T12:00:01.000Z] Worker2: actual worker reply');
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('outbound echo'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('1 more'));
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
    expect(relaycastClient.dms.messages).toHaveBeenCalledWith('dm_1', { limit: 100 });
    expect(deps.log).toHaveBeenCalledWith(
      '    [2026-02-20T12:00:01.000Z] Worker2: worker reply hidden behind outbound echoes'
    );
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('newer outbound echo'));
    expect(deps.log).not.toHaveBeenCalledWith(
      expect.stringContaining('run `agent-relay replies Worker2 --unread`')
    );
  });

  it('inbox --json does not execute text-renderer DM message fetches', async () => {
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
          throw new Error('text renderer fetch should not run in json mode');
        }),
      },
    });
    const { program, deps } = createHarness({ relaycastClient });

    const exitCode = await runCommand(program, ['inbox', '--json']);

    expect(exitCode).toBeUndefined();
    expect(relaycastClient.dms.messages).not.toHaveBeenCalled();
    const parsed = JSON.parse((deps.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(parsed.unread_dms).toEqual([
      {
        conversation_id: 'dm_1',
        from: 'Worker2',
        unread_count: 1,
        last_message: null,
      },
    ]);
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
