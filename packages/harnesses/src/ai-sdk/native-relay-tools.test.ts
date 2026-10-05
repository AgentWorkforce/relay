import { describe, expect, it, vi } from 'vitest';
import { createNativeRelayTools, NATIVE_RELAY_INSTRUCTIONS } from './native-relay-tools.js';

describe('native Relay host tools', () => {
  it('does not expose unauthenticated tools', () => {
    expect(createNativeRelayTools({ env: {} })).toEqual([]);
  });

  it('installs authenticated messaging and discovery tools', async () => {
    const dm = vi.fn(async () => ({ id: 'message-1' }));
    const listAgents = vi.fn(async () => [{ name: 'nativeClaude' }]);
    const tools = createNativeRelayTools({
      env: {
        RELAY_AGENT_TOKEN: 'at_live_test',
        RELAY_WORKSPACE_KEY: 'rk_live_test',
      },
      agentClient: {
        dm,
        send: vi.fn(),
        messages: vi.fn(),
        reply: vi.fn(),
        thread: vi.fn(),
        dms: {
          conversations: vi.fn(),
          messages: vi.fn(),
          createGroup: vi.fn(),
          sendMessage: vi.fn(),
        },
        channels: {
          create: vi.fn(),
          list: vi.fn(),
          join: vi.fn(),
          leave: vi.fn(),
          invite: vi.fn(),
          setTopic: vi.fn(),
          archive: vi.fn(),
        },
        react: vi.fn(),
        unreact: vi.fn(),
        search: vi.fn(),
        inbox: vi.fn(),
        markRead: vi.fn(),
        readers: vi.fn(),
      } as never,
      workspaceClient: { agents: { list: listAgents } } as never,
    });

    expect(tools.map((tool) => tool.spec.name)).toEqual(
      expect.arrayContaining(['send_dm', 'post_message', 'list_agents', 'check_inbox'])
    );
    await tools
      .find((tool) => tool.spec.name === 'send_dm')!
      .execute({ to: 'nativeClaude', text: 'hello' }, {});
    expect(dm).toHaveBeenCalledWith('nativeClaude', 'hello');
    await tools.find((tool) => tool.spec.name === 'list_agents')!.execute({}, {});
    expect(listAgents).toHaveBeenCalledWith({ status: undefined });
    expect(NATIVE_RELAY_INSTRUCTIONS).toContain('Do not ask the user how to use Relay');
  });
});

it.each([
  ['post_message', 'send', { channel: 'events', text: 'ACK' }],
  ['reply_to_thread', 'reply', { message_id: 'parent', text: 'ACK' }],
] as const)('joins pending native %s writes within a session only', async (tool, method, args) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = vi.fn(async () => {
    await gate;
    return { id: 'reply' };
  });
  const options = { env: { RELAY_AGENT_TOKEN: 'test' }, agentClient: { [method]: write } as never };
  const execute = createNativeRelayTools(options).find((item) => item.spec.name === tool)!.execute;
  const first = execute(args, {});
  const second = execute(args, {});
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  const anotherSession = createNativeRelayTools(options)
    .find((item) => item.spec.name === tool)!
    .execute(args, {});
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(2);
  release();
  expect(await first).toEqual(await second);
  await anotherSession;
  await execute(args, {});
  expect(write).toHaveBeenCalledTimes(3);
});

it('clears a rejected native reply so it can be retried', async () => {
  const reply = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ id: 'retry' });
  const execute = createNativeRelayTools({
    env: { RELAY_AGENT_TOKEN: 'test' },
    agentClient: { reply } as never,
  }).find((item) => item.spec.name === 'reply_to_thread')!.execute;
  const args = { message_id: 'parent', text: 'ACK' };
  await expect(execute(args, {})).rejects.toThrow('offline');
  await expect(execute(args, {})).resolves.toEqual({ id: 'retry' });
  expect(reply).toHaveBeenCalledTimes(2);
});
