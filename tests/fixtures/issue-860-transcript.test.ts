import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerMessagingCommands,
  type MessagingBrokerClient,
  type MessagingDependencies,
  type MessagingRelaycastClient,
} from '../../src/cli/commands/messaging.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit:${code}`);
  }
}

type TranscriptDirection = 'inbound' | 'outbound';

interface TranscriptMessage {
  id: string;
  conversationId: string;
  agentName: string;
  text: string;
  createdAt: string;
  unread: boolean;
  direction: TranscriptDirection;
}

interface TranscriptState {
  messages: TranscriptMessage[];
  registeredAgents: string[];
  markedRead: string[];
}

function seedTranscript(): TranscriptState {
  return {
    registeredAgents: [],
    markedRead: [],
    messages: [
      {
        id: 'issue-860-outbound-create-result',
        conversationId: 'dm-orchestrator-worker2',
        agentName: 'orchestrator',
        text: 'Create a file called result.json with {"status":"success","worker":"claude"}.',
        createdAt: '2026-05-15T15:29:10.000Z',
        unread: false,
        direction: 'outbound',
      },
      {
        id: 'issue-860-worker2-got-it',
        conversationId: 'dm-orchestrator-worker2',
        agentName: 'Worker2',
        text: 'Got it.',
        createdAt: '2026-05-15T15:30:40.000Z',
        unread: false,
        direction: 'inbound',
      },
      {
        id: 'issue-860-worker2-working',
        conversationId: 'dm-orchestrator-worker2',
        agentName: 'Worker2',
        text: 'Working on it now.',
        createdAt: '2026-05-15T15:30:55.000Z',
        unread: true,
        direction: 'inbound',
      },
      {
        id: 'issue-860-worker2-done',
        conversationId: 'dm-orchestrator-worker2',
        agentName: 'Worker2',
        text: 'Done. Created result.json with {"status":"success","worker":"claude"}.',
        createdAt: '2026-05-15T15:31:02.000Z',
        unread: true,
        direction: 'inbound',
      },
    ],
  };
}

function createBrokerClientMock(overrides: Partial<MessagingBrokerClient> = {}): MessagingBrokerClient {
  return {
    sendMessage: vi.fn(async () => ({ event_id: 'evt_860', targets: [] })),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

function newestFirst(messages: TranscriptMessage[]): TranscriptMessage[] {
  return [...messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

function createRelaycastClientMock(
  state: TranscriptState,
  reader: string,
  overrides: Partial<MessagingRelaycastClient> = {}
): MessagingRelaycastClient {
  const now = new Date('2026-05-15T15:31:10.000Z');
  const markRead = vi.fn(async (messageId: string) => {
    for (const message of state.messages) {
      if (message.id === messageId) {
        message.unread = false;
        state.markedRead.push(message.id);
      }
    }
  });
  const markMessagesRead = vi.fn(async (_conversationId?: string, messageIds?: string[]) => {
    const ids = new Set(messageIds ?? []);
    for (const message of state.messages) {
      if (ids.has(message.id)) {
        message.unread = false;
        state.markedRead.push(message.id);
      }
    }
  });

  const client = {
    message: vi.fn(async (id: string) => {
      const message = state.messages.find((item) => item.id === id) ?? state.messages[0];
      return {
        id: message.id,
        agent_name: message.agentName,
        text: message.text,
        created_at: message.createdAt,
      };
    }),
    messages: vi.fn(async () => []),
    inbox: vi.fn(async () => {
      const unreadMessages = newestFirst(
        state.messages.filter((message) => message.agentName !== reader && message.unread)
      );
      const lastMessage = unreadMessages[0];
      return {
        unread_channels: [],
        mentions: [],
        unread_dms: lastMessage
          ? [
              {
                conversation_id: lastMessage.conversationId,
                from: lastMessage.agentName,
                unread_count: unreadMessages.length,
                last_message: {
                  id: lastMessage.id,
                  text: lastMessage.text,
                  created_at: lastMessage.createdAt,
                },
              },
            ]
          : [],
        recent_reactions: [],
      };
    }),
    dm: vi.fn(async (to: string, text: string) => {
      state.messages.push({
        id: `issue-860-send-${state.messages.length + 1}`,
        conversationId: 'dm-orchestrator-worker2',
        agentName: reader,
        text,
        createdAt: now.toISOString(),
        unread: false,
        direction: to === 'Worker2' ? 'outbound' : 'inbound',
      });
    }),
    post: vi.fn(async () => undefined),
    dms: {
      conversations: vi.fn(async () => [
        {
          id: 'dm-orchestrator-worker2',
          participants: [{ agentName: 'orchestrator' }, { agentName: 'Worker2' }],
          lastMessage: {
            id: 'issue-860-worker2-done',
            text: 'Done. Created result.json with {"status":"success","worker":"claude"}.',
            agentName: 'Worker2',
            createdAt: '2026-05-15T15:31:02.000Z',
          },
          unreadCount: state.messages.filter((message) => message.unread).length,
          createdAt: '2026-05-15T15:29:10.000Z',
        },
      ]),
      messages: vi.fn(async (_conversationId: string, opts?: { limit?: number }) =>
        newestFirst(state.messages)
          .slice(0, opts?.limit ?? 50)
          .map((message) => ({
            id: message.id,
            agentName: message.agentName,
            text: message.text,
            createdAt: message.createdAt,
            unread: message.unread,
          }))
      ),
      markRead: markMessagesRead,
      markMessagesRead,
    },
    markRead,
    markMessagesRead,
    ...overrides,
  };

  return client as unknown as MessagingRelaycastClient;
}

function createHarness(options?: {
  state?: TranscriptState;
  brokerClient?: MessagingBrokerClient;
  relaycastClient?: MessagingRelaycastClient;
  projectRoot?: string;
}) {
  const state = options?.state ?? seedTranscript();
  const brokerClient = options?.brokerClient ?? createBrokerClientMock();
  const projectRoot = options?.projectRoot ?? '/tmp/issue-860-project';

  const exit = vi.fn((code: number) => {
    throw new ExitSignal(code);
  }) as unknown as MessagingDependencies['exit'];

  const deps: MessagingDependencies = {
    getProjectRoot: vi.fn(() => projectRoot),
    createClient: vi.fn(() => brokerClient),
    createRelaycastClient: vi.fn(async ({ agentName }) => {
      state.registeredAgents.push(agentName);
      return options?.relaycastClient ?? createRelaycastClientMock(state, agentName);
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

  return { program, deps, brokerClient, state };
}

async function runCommand(program: Command, args: string[]): Promise<number | undefined> {
  try {
    await program.parseAsync(args, { from: 'user' });
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitSignal) {
      return err.code;
    }
    if (typeof (err as { exitCode?: unknown })?.exitCode === 'number') {
      return (err as { exitCode: number }).exitCode;
    }
    throw err;
  }
}

async function runTranscriptCommand(
  state: TranscriptState,
  args: string[]
): Promise<ReturnType<typeof createHarness> & { exitCode: number | undefined }> {
  const harness = createHarness({ state });
  const exitCode = await runCommand(harness.program, args);
  return { ...harness, exitCode };
}

function outputText(deps: MessagingDependencies): string {
  return (deps.log as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0] ?? '')).join('\n');
}

function jsonOutput(deps: MessagingDependencies): unknown {
  const line = (deps.log as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call[0])
    .find((value) => typeof value === 'string' && value.trimStart().startsWith('['));
  expect(line).toBeDefined();
  return JSON.parse(line as string);
}

function expectInOrder(text: string, expected: string[]): void {
  let cursor = -1;
  for (const item of expected) {
    const next = text.indexOf(item, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe('issue #860 transcript replay fixture', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the spec transcript timestamps and participants', () => {
    const state = seedTranscript();

    expect(state.messages.map(({ agentName, createdAt, text }) => ({ agentName, createdAt, text }))).toEqual([
      {
        agentName: 'orchestrator',
        createdAt: '2026-05-15T15:29:10.000Z',
        text: 'Create a file called result.json with {"status":"success","worker":"claude"}.',
      },
      { agentName: 'Worker2', createdAt: '2026-05-15T15:30:40.000Z', text: 'Got it.' },
      { agentName: 'Worker2', createdAt: '2026-05-15T15:30:55.000Z', text: 'Working on it now.' },
      {
        agentName: 'Worker2',
        createdAt: '2026-05-15T15:31:02.000Z',
        text: 'Done. Created result.json with {"status":"success","worker":"claude"}.',
      },
    ]);
  });

  it('replays the reporter path without losing the worker reply text', async () => {
    const state = seedTranscript();
    const replies = await runTranscriptCommand(state, ['replies', 'Worker2']);
    const inbox = await runTranscriptCommand(state, ['inbox', '--agent', 'orchestrator']);
    const history = await runTranscriptCommand(state, ['history', '--to', 'Worker2']);

    expect(replies.exitCode).toBeUndefined();
    expect(inbox.exitCode).toBeUndefined();
    expect(history.exitCode).toBeUndefined();
    expect(outputText(replies.deps)).toContain(
      'Done. Created result.json with {"status":"success","worker":"claude"}.'
    );
    expect(outputText(inbox.deps)).toContain('Working on it now.');
    expect(outputText(history.deps)).toContain('Create a file called result.json');
  });
});

describe('issue #860 replies command', () => {
  it('prints only inbound Worker2 messages in chronological order', async () => {
    const state = seedTranscript();
    const { deps, exitCode } = await runTranscriptCommand(state, ['replies', 'Worker2']);
    const text = outputText(deps);

    expect(exitCode).toBeUndefined();
    expectInOrder(text, [
      'Got it.',
      'Working on it now.',
      'Done. Created result.json with {"status":"success","worker":"claude"}.',
    ]);
    expect(text).toContain('Worker2');
    expect(text).not.toContain('Create a file called result.json');
  });

  it('supports unread and mark-read without hiding read transcript messages', async () => {
    const state = seedTranscript();
    const unread = await runTranscriptCommand(state, ['replies', 'Worker2', '--unread']);
    const relaycastClient = createRelaycastClientMock(state, 'orchestrator');
    const markRead = createHarness({ state, relaycastClient });
    const markReadExitCode = await runCommand(markRead.program, [
      'replies',
      'Worker2',
      '--unread',
      '--mark-read',
    ]);
    const unreadAfterMark = await runTranscriptCommand(state, ['replies', 'Worker2', '--unread']);

    expect(unread.exitCode).toBeUndefined();
    expect(outputText(unread.deps)).toContain('Working on it now.');
    expect(outputText(unread.deps)).not.toContain('Got it.');
    expect(markReadExitCode).toBeUndefined();
    expect(relaycastClient.markRead).toHaveBeenCalledTimes(2);
    expect(relaycastClient.markRead).toHaveBeenNthCalledWith(1, 'issue-860-worker2-working');
    expect(relaycastClient.markRead).toHaveBeenNthCalledWith(2, 'issue-860-worker2-done');
    expect(state.markedRead).toEqual(['issue-860-worker2-working', 'issue-860-worker2-done']);
    expect(unreadAfterMark.exitCode).toBeUndefined();
    expect(outputText(unreadAfterMark.deps)).not.toContain('Working on it now.');
    expect(outputText(unreadAfterMark.deps)).not.toContain('Done. Created result.json');
  });

  it('emits inbound direction in JSON output', async () => {
    const state = seedTranscript();
    const { deps, exitCode } = await runTranscriptCommand(state, ['replies', 'Worker2', '--json']);

    expect(exitCode).toBeUndefined();
    expect(jsonOutput(deps)).toEqual([
      expect.objectContaining({ from: 'Worker2', direction: 'inbound', text: 'Got it.' }),
      expect.objectContaining({ from: 'Worker2', direction: 'inbound', text: 'Working on it now.' }),
      expect.objectContaining({
        from: 'Worker2',
        direction: 'inbound',
        text: 'Done. Created result.json with {"status":"success","worker":"claude"}.',
      }),
    ]);
  });
});

describe('issue #860 inbox renderer', () => {
  it('renders unread DM content instead of a count-only summary', async () => {
    const state = seedTranscript();
    const { deps, exitCode } = await runTranscriptCommand(state, ['inbox', '--agent', 'orchestrator']);
    const text = outputText(deps);

    expect(exitCode).toBeUndefined();
    expect(text).toContain('Unread DMs:');
    expect(text).toContain('Worker2');
    expect(text).toContain('Working on it now.');
    expect(text).toContain('Done. Created result.json with {"status":"success","worker":"claude"}.');
    expect(text).not.toMatch(/Worker2:\s*2\s*$/m);
  });

  it('prints overflow guidance when a conversation has more than three unread messages', async () => {
    const state = seedTranscript();
    state.messages.push(
      {
        id: 'issue-860-worker2-follow-up',
        conversationId: 'dm-orchestrator-worker2',
        agentName: 'Worker2',
        text: 'One more implementation detail is ready.',
        createdAt: '2026-05-15T15:31:04.000Z',
        unread: true,
        direction: 'inbound',
      },
      {
        id: 'issue-860-worker2-final-note',
        conversationId: 'dm-orchestrator-worker2',
        agentName: 'Worker2',
        text: 'Final note before handoff.',
        createdAt: '2026-05-15T15:31:06.000Z',
        unread: true,
        direction: 'inbound',
      }
    );

    const { deps, exitCode } = await runTranscriptCommand(state, ['inbox', '--agent', 'orchestrator']);
    const text = outputText(deps);

    expect(exitCode).toBeUndefined();
    expect(text).toContain('Worker2');
    expect(text).toContain('Final note before handoff.');
    expect(text).toContain('One more implementation detail is ready.');
    expect(text).toContain('Done. Created result.json with {"status":"success","worker":"claude"}.');
    expect(text).toContain("… (1 more — run `agent-relay replies 'Worker2' --unread` to see all)");
  });

  it('keeps inbox JSON structured while carrying message direction', async () => {
    const state = seedTranscript();
    const { deps, exitCode } = await runTranscriptCommand(state, [
      'inbox',
      '--agent',
      'orchestrator',
      '--json',
    ]);
    const parsed = JSON.parse(outputText(deps));

    expect(exitCode).toBeUndefined();
    expect(parsed.unread_dms).toEqual([
      expect.objectContaining({
        conversation_id: 'dm-orchestrator-worker2',
        from: 'Worker2',
        unread_count: 2,
        last_message: expect.objectContaining({
          text: 'Done. Created result.json with {"status":"success","worker":"claude"}.',
          direction: 'inbound',
        }),
      }),
    ]);
  });
});

describe('issue #860 history rewrite', () => {
  it('prints DM messages for --to Worker2 rather than conversation previews', async () => {
    const state = seedTranscript();
    const { deps, exitCode } = await runTranscriptCommand(state, ['history', '--to', 'Worker2']);
    const text = outputText(deps);

    expect(exitCode).toBeUndefined();
    expect(text).not.toContain('DM conversations for Worker2');
    expectInOrder(text, [
      'orchestrator',
      'Create a file called result.json with {"status":"success","worker":"claude"}.',
      'Worker2',
      'Got it.',
      'Working on it now.',
      'Done. Created result.json with {"status":"success","worker":"claude"}.',
    ]);
  });

  it('adds direction to history JSON relative to the orchestrator reader', async () => {
    const state = seedTranscript();
    const { deps, exitCode } = await runTranscriptCommand(state, ['history', '--to', 'Worker2', '--json']);
    const parsed = jsonOutput(deps);

    expect(exitCode).toBeUndefined();
    expect(parsed).toEqual([
      expect.objectContaining({ from: 'orchestrator', direction: 'outbound' }),
      expect.objectContaining({ from: 'Worker2', direction: 'inbound', text: 'Got it.' }),
      expect.objectContaining({ from: 'Worker2', direction: 'inbound', text: 'Working on it now.' }),
      expect.objectContaining({
        from: 'Worker2',
        direction: 'inbound',
        text: 'Done. Created result.json with {"status":"success","worker":"claude"}.',
      }),
    ]);
  });
});

describe('issue #860 default sender flip', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends without --from as orchestrator and keeps the broker fallback out of the happy path', async () => {
    const state = seedTranscript();
    const {
      deps,
      brokerClient,
      exitCode,
      state: updatedState,
    } = await runTranscriptCommand(state, ['send', 'Worker2', 'ping after transcript']);

    expect(exitCode).toBeUndefined();
    expect(updatedState.registeredAgents).toContain('orchestrator');
    expect(updatedState.messages).toContainEqual(
      expect.objectContaining({
        agentName: 'orchestrator',
        text: 'ping after transcript',
        direction: 'outbound',
      })
    );
    expect(brokerClient.sendMessage).not.toHaveBeenCalled();
    expect(deps.createClient).not.toHaveBeenCalled();
  });

  it('honors AGENT_RELAY_ORCHESTRATOR_NAME when --from is omitted', async () => {
    vi.stubEnv('AGENT_RELAY_ORCHESTRATOR_NAME', 'ops');
    const state = seedTranscript();
    const { exitCode, state: updatedState } = await runTranscriptCommand(state, [
      'send',
      'Worker2',
      'ops-owned ping',
    ]);

    expect(exitCode).toBeUndefined();
    expect(updatedState.registeredAgents).toContain('ops');
    expect(updatedState.messages).toContainEqual(
      expect.objectContaining({
        agentName: 'ops',
        text: 'ops-owned ping',
      })
    );
  });
});

describe('issue #860 outbound suppression', () => {
  it('does not treat the orchestrator outbound DM as a reply headline', async () => {
    const state = seedTranscript();
    const { deps, exitCode } = await runTranscriptCommand(state, ['replies', 'Worker2', '--json']);
    const parsed = jsonOutput(deps) as Array<{ from: string; text: string; direction: TranscriptDirection }>;

    expect(exitCode).toBeUndefined();
    expect(parsed).toHaveLength(3);
    expect(parsed.map((message) => message.text)).toEqual([
      'Got it.',
      'Working on it now.',
      'Done. Created result.json with {"status":"success","worker":"claude"}.',
    ]);
    expect(parsed.every((message) => message.from === 'Worker2')).toBe(true);
    expect(parsed.every((message) => message.direction === 'inbound')).toBe(true);
    expect(parsed.map((message) => message.text)).not.toContain(
      'Create a file called result.json with {"status":"success","worker":"claude"}.'
    );
  });

  it('does not let a newer outbound ping hide the latest Worker2 reply', async () => {
    const state = seedTranscript();
    await runTranscriptCommand(state, ['send', 'Worker2', 'status?']);
    const { deps, exitCode } = await runTranscriptCommand(state, ['replies', 'Worker2']);
    const text = outputText(deps);

    expect(exitCode).toBeUndefined();
    expect(text).toContain('Done. Created result.json with {"status":"success","worker":"claude"}.');
    expect(text).not.toContain('status?');
  });
});
