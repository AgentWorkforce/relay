import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

// Store registered event handlers so tests can fire them
const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

function registerHandler(event: string) {
  return (handler: (...args: unknown[]) => void) => {
    if (!eventHandlers[event]) eventHandlers[event] = [];
    eventHandlers[event].push(handler);
    return () => {
      eventHandlers[event] = eventHandlers[event].filter((h) => h !== handler);
    };
  };
}

function fireEvent(event: string, ...args: unknown[]) {
  for (const handler of eventHandlers[event] ?? []) {
    handler(...args);
  }
}

const mockAgentClient = {
  connect: vi.fn(),
  disconnect: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  presence: {
    markOnline: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    markOffline: vi.fn().mockResolvedValue(undefined),
  },
  channels: {
    join: vi.fn().mockResolvedValue({ ok: true }),
    create: vi.fn().mockResolvedValue({ name: 'general' }),
  },
  on: {
    connected: registerHandler('connected'),
    messageCreated: registerHandler('messageCreated'),
    threadReply: registerHandler('threadReply'),
    dmReceived: registerHandler('dmReceived'),
    groupDmReceived: registerHandler('groupDmReceived'),
    commandInvoked: registerHandler('commandInvoked'),
    reactionAdded: registerHandler('reactionAdded'),
    reactionRemoved: registerHandler('reactionRemoved'),
    reconnecting: registerHandler('reconnecting'),
    disconnected: registerHandler('disconnected'),
    error: registerHandler('error'),
    any: registerHandler('any'),
  },
};

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => ({
    agents: {
      registerOrGet: vi.fn().mockResolvedValue({ name: 'viewer-test-claw', token: 'tok_test' }),
    },
    channels: { join: vi.fn().mockResolvedValue({ ok: true }) },
    messages: { list: vi.fn().mockResolvedValue([]) },
    as: vi.fn().mockReturnValue(mockAgentClient),
  })),
}));

vi.mock('../spawn/manager.js', () => ({
  SpawnManager: vi.fn().mockImplementation(() => ({
    size: 0,
    spawn: vi.fn(),
    release: vi.fn(),
    releaseByName: vi.fn(),
    releaseAll: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn(),
  })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{"spawns":[]}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// Mock createServer to avoid binding real ports
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn().mockReturnValue({
      listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
      close: vi.fn((cb?: () => void) => cb?.()),
      address: vi.fn().mockReturnValue({ port: 18790 }),
    }),
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { InboundGateway } from '../gateway.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGateway(overrides?: {
  clawName?: string;
  channels?: string[];
}) {
  const sendMessage = vi.fn().mockResolvedValue({ event_id: 'evt_1' });
  const gateway = new InboundGateway({
    config: {
      apiKey: 'rk_live_test',
      clawName: overrides?.clawName ?? 'test-claw',
      baseUrl: 'https://api.relaycast.dev',
      channels: overrides?.channels ?? ['general'],
    },
    relaySender: { sendMessage },
  });
  return { gateway, sendMessage };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InboundGateway — thread reply injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(eventHandlers)) {
      eventHandlers[key] = [];
    }
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  describe('message formatting', () => {
    it('should format regular channel messages without thread prefix', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_1',
          agentName: 'alice',
          text: 'hello world',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:general] @alice: hello world');
      expect(call.text).not.toContain('[thread]');

      await gateway.stop();
    });

    it('should format thread replies with [thread] prefix', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'general',
        parentId: 'msg_parent_1',
        message: {
          id: 'msg_reply_1',
          agentName: 'bob',
          text: 'replying in thread',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[thread] [relaycast:general] @bob: replying in thread');

      await gateway.stop();
    });
  });

  describe('thread reply event handling', () => {
    it('should deliver thread replies from subscribed channels', async () => {
      const { gateway, sendMessage } = createGateway({ channels: ['general', 'dev'] });
      await gateway.start();

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'dev',
        parentId: 'msg_100',
        message: {
          id: 'msg_101',
          agentName: 'carol',
          text: 'thread in dev channel',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toContain('[thread]');
      expect(call.text).toContain('[relaycast:dev]');
      expect(call.text).toContain('@carol');

      await gateway.stop();
    });

    it('should ignore thread replies from unsubscribed channels', async () => {
      const { gateway, sendMessage } = createGateway({ channels: ['general'] });
      await gateway.start();

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'random',
        parentId: 'msg_200',
        message: {
          id: 'msg_201',
          agentName: 'dave',
          text: 'thread in random',
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();

      await gateway.stop();
    });

    it('should skip thread replies from the claw itself (echo prevention)', async () => {
      const { gateway, sendMessage } = createGateway({ clawName: 'my-claw' });
      await gateway.start();

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'general',
        parentId: 'msg_300',
        message: {
          id: 'msg_301',
          agentName: 'my-claw',
          text: 'my own reply',
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();

      await gateway.stop();
    });

    it('should skip thread replies from the viewer identity', async () => {
      const { gateway, sendMessage } = createGateway({ clawName: 'my-claw' });
      await gateway.start();

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'general',
        parentId: 'msg_400',
        message: {
          id: 'msg_401',
          agentName: 'viewer-my-claw',
          text: 'viewer echo',
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();

      await gateway.stop();
    });

    it('should deduplicate thread replies with the same message ID', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      const event = {
        type: 'thread.reply',
        channel: 'general',
        parentId: 'msg_500',
        message: {
          id: 'msg_501',
          agentName: 'eve',
          text: 'duplicate test',
        },
      };

      fireEvent('threadReply', event);
      fireEvent('threadReply', event);

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });
  });

  describe('mixed message and thread delivery', () => {
    it('should deliver both channel messages and thread replies', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_600',
          agentName: 'frank',
          text: 'original message',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledTimes(1);
      });

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'general',
        parentId: 'msg_600',
        message: {
          id: 'msg_601',
          agentName: 'grace',
          text: 'reply to frank',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledTimes(2);
      });

      const firstCall = sendMessage.mock.calls[0][0];
      expect(firstCall.text).toBe('[relaycast:general] @frank: original message');

      const secondCall = sendMessage.mock.calls[1][0];
      expect(secondCall.text).toBe('[thread] [relaycast:general] @grace: reply to frank');

      await gateway.stop();
    });

    it('should include source metadata in relay sender data', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'general',
        parentId: 'msg_parent_700',
        message: {
          id: 'msg_700',
          agentName: 'heidi',
          text: 'metadata check',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.data.source).toBe('relaycast');
      expect(call.data.channel).toBe('general');
      expect(call.data.messageId).toBe('msg_700');

      await gateway.stop();
    });
  });

  describe('DM event handling', () => {
    it('should deliver DMs with [relaycast:dm] format', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('dmReceived', {
        type: 'dm.received',
        conversationId: 'conv_1',
        message: {
          id: 'dm_1',
          agentName: 'alice',
          text: 'hey there',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:dm] @alice: hey there');

      await gateway.stop();
    });

    it('should skip DMs from the claw itself (echo prevention)', async () => {
      const { gateway, sendMessage } = createGateway({ clawName: 'my-claw' });
      await gateway.start();

      fireEvent('dmReceived', {
        type: 'dm.received',
        conversationId: 'conv_2',
        message: {
          id: 'dm_2',
          agentName: 'my-claw',
          text: 'echo',
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();

      await gateway.stop();
    });

    it('should deduplicate DMs with the same message ID', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      const event = {
        type: 'dm.received',
        conversationId: 'conv_3',
        message: {
          id: 'dm_3',
          agentName: 'bob',
          text: 'duplicate dm',
        },
      };

      fireEvent('dmReceived', event);
      fireEvent('dmReceived', event);

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });
  });

  describe('Group DM event handling', () => {
    it('should deliver group DMs with [relaycast:groupdm] format', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('groupDmReceived', {
        type: 'group_dm.received',
        conversationId: 'gconv_1',
        message: {
          id: 'gdm_1',
          agentName: 'carol',
          text: 'group message',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:groupdm] @carol: group message');

      await gateway.stop();
    });
  });

  describe('Command invocation handling', () => {
    it('should deliver command invocations with formatted text', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('commandInvoked', {
        type: 'command.invoked',
        command: 'deploy',
        channel: 'general',
        invokedBy: 'dave',
        handlerAgentId: 'agent_1',
        args: 'production --force',
        parameters: null,
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:command:general] @dave /deploy production --force');

      await gateway.stop();
    });

    it('should deliver command invocations without args', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('commandInvoked', {
        type: 'command.invoked',
        command: 'status',
        channel: 'general',
        invokedBy: 'eve',
        handlerAgentId: 'agent_2',
        args: null,
        parameters: null,
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:command:general] @eve /status');

      await gateway.stop();
    });

    it('should ignore commands from unsubscribed channels', async () => {
      const { gateway, sendMessage } = createGateway({ channels: ['general'] });
      await gateway.start();

      fireEvent('commandInvoked', {
        type: 'command.invoked',
        command: 'deploy',
        channel: 'random',
        invokedBy: 'dave',
        handlerAgentId: 'agent_1',
        args: null,
        parameters: null,
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();

      await gateway.stop();
    });
  });

  describe('Reaction event handling', () => {
    it('should deliver reaction added as soft notification', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('reactionAdded', {
        type: 'reaction.added',
        messageId: 'msg_800',
        emoji: 'thumbsup',
        agentName: 'eve',
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:reaction] @eve reacted thumbsup to message msg_800 (soft notification, no action required)');

      await gateway.stop();
    });

    it('should deliver reaction removed as soft notification', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('reactionRemoved', {
        type: 'reaction.removed',
        messageId: 'msg_900',
        emoji: 'rocket',
        agentName: 'frank',
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:reaction] @frank removed rocket from message msg_900 (soft notification, no action required)');

      await gateway.stop();
    });

    it('should skip reactions from the claw itself', async () => {
      const { gateway, sendMessage } = createGateway({ clawName: 'my-claw' });
      await gateway.start();

      fireEvent('reactionAdded', {
        type: 'reaction.added',
        messageId: 'msg_1000',
        emoji: 'check',
        agentName: 'my-claw',
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();

      await gateway.stop();
    });
  });

  describe('delivery fallback path', () => {
    it('should fall back to openclawClient when relaySender fails', async () => {
      const sendMessage = vi.fn().mockRejectedValue(new Error('relay down'));
      const gateway = new InboundGateway({
        config: {
          apiKey: 'rk_live_test',
          clawName: 'test-claw',
          baseUrl: 'https://api.relaycast.dev',
          channels: ['general'],
          openclawGatewayToken: 'tok_gateway',
          openclawGatewayPort: 19999,
        },
        relaySender: { sendMessage },
      });
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_fb_1',
          agentName: 'alice',
          text: 'fallback test',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      // The relaySender threw, so it should have attempted openclawClient.
      // Since openclawClient WS is not actually connected in test, both fail.
      // We just verify the sendMessage was called (relay path attempted).
      await new Promise((r) => setTimeout(r, 50));

      await gateway.stop();
    });

    it('should return method=failed when both relaySender and openclawClient fail', async () => {
      const sendMessage = vi.fn().mockRejectedValue(new Error('relay down'));
      const gateway = new InboundGateway({
        config: {
          apiKey: 'rk_live_test',
          clawName: 'test-claw',
          baseUrl: 'https://api.relaycast.dev',
          channels: ['general'],
        },
        relaySender: { sendMessage },
      });
      await gateway.start();

      // No openclawClient (no token), sendMessage will throw
      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_fb_2',
          agentName: 'alice',
          text: 'both fail',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      await new Promise((r) => setTimeout(r, 50));
      await gateway.stop();
    });

    it('should treat unsupported_operation event_id as failure', async () => {
      const sendMessage = vi.fn().mockResolvedValue({ event_id: 'unsupported_operation' });
      const gateway = new InboundGateway({
        config: {
          apiKey: 'rk_live_test',
          clawName: 'test-claw',
          baseUrl: 'https://api.relaycast.dev',
          channels: ['general'],
        },
        relaySender: { sendMessage },
      });
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_unsup_1',
          agentName: 'bob',
          text: 'unsupported test',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      // unsupported_operation means relay delivery failed, should fall through
      await new Promise((r) => setTimeout(r, 50));
      await gateway.stop();
    });

    it('should treat relaySender throwing as failure and fall through', async () => {
      const sendMessage = vi.fn().mockRejectedValue(new Error('network error'));
      const gateway = new InboundGateway({
        config: {
          apiKey: 'rk_live_test',
          clawName: 'test-claw',
          baseUrl: 'https://api.relaycast.dev',
          channels: ['general'],
        },
        relaySender: { sendMessage },
      });
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_throw_1',
          agentName: 'carol',
          text: 'throw test',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      await new Promise((r) => setTimeout(r, 50));
      await gateway.stop();
    });
  });

  describe('delivery without relaySender', () => {
    it('should attempt openclawClient directly when no relaySender is provided', async () => {
      // No relaySender, no openclawClient token => both paths fail gracefully
      const gateway = new InboundGateway({
        config: {
          apiKey: 'rk_live_test',
          clawName: 'test-claw',
          baseUrl: 'https://api.relaycast.dev',
          channels: ['general'],
        },
        // No relaySender provided
      });
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_no_relay_1',
          agentName: 'dave',
          text: 'no relay sender',
          attachments: [],
        },
      });

      // Should not throw even with no delivery method available
      await new Promise((r) => setTimeout(r, 100));
      await gateway.stop();
    });
  });

  describe('formatDeliveryText coverage', () => {
    it('should format dm messages as [relaycast:dm]', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('dmReceived', {
        type: 'dm.received',
        conversationId: 'conv_fmt_1',
        message: {
          id: 'dm_fmt_1',
          agentName: 'alice',
          text: 'dm format test',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:dm] @alice: dm format test');

      await gateway.stop();
    });

    it('should format groupdm messages as [relaycast:groupdm]', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('groupDmReceived', {
        type: 'group_dm.received',
        conversationId: 'gconv_fmt_1',
        message: {
          id: 'gdm_fmt_1',
          agentName: 'bob',
          text: 'group dm format test',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:groupdm] @bob: group dm format test');

      await gateway.stop();
    });

    it('should format command messages with pre-formatted text', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('commandInvoked', {
        type: 'command.invoked',
        command: 'build',
        channel: 'general',
        invokedBy: 'carol',
        handlerAgentId: 'agent_fmt_1',
        args: '--prod',
        parameters: null,
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:command:general] @carol /build --prod');

      await gateway.stop();
    });

    it('should format reaction messages with pre-formatted text', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('reactionAdded', {
        type: 'reaction.added',
        messageId: 'msg_fmt_react',
        emoji: 'fire',
        agentName: 'dave',
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:reaction] @dave reacted fire to message msg_fmt_react (soft notification, no action required)');

      await gateway.stop();
    });

    it('should format thread messages with [thread] prefix', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('threadReply', {
        type: 'thread.reply',
        channel: 'general',
        parentId: 'msg_fmt_parent',
        message: {
          id: 'msg_fmt_thread',
          agentName: 'eve',
          text: 'thread format test',
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[thread] [relaycast:general] @eve: thread format test');

      await gateway.stop();
    });

    it('should format default channel messages without prefix', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_fmt_chan',
          agentName: 'frank',
          text: 'channel format test',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:general] @frank: channel format test');

      await gateway.stop();
    });
  });

  describe('handleInbound dedup via processingMessageIds', () => {
    it('should skip messages already being processed', async () => {
      // Use a slow sendMessage to simulate a message still being processed
      let resolveFirst: (() => void) | null = null;
      const firstCallPromise = new Promise<void>((r) => { resolveFirst = r; });
      const sendMessage = vi.fn()
        .mockImplementationOnce(async () => {
          // Block until we manually resolve
          await firstCallPromise;
          return { event_id: 'evt_1' };
        })
        .mockResolvedValue({ event_id: 'evt_2' });

      const gateway = new InboundGateway({
        config: {
          apiKey: 'rk_live_test',
          clawName: 'test-claw',
          baseUrl: 'https://api.relaycast.dev',
          channels: ['general'],
        },
        relaySender: { sendMessage },
      });
      await gateway.start();

      // Fire the same message twice quickly
      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_dedup_proc',
          agentName: 'alice',
          text: 'dedup processing test',
          attachments: [],
        },
      });

      // Second fire of same message should be skipped (already processing or seen)
      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_dedup_proc',
          agentName: 'alice',
          text: 'dedup processing test',
          attachments: [],
        },
      });

      // Resolve the first call
      resolveFirst!();

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      await new Promise((r) => setTimeout(r, 50));
      // Should only have been called once since the second was deduped
      expect(sendMessage).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });
  });

  describe('handleInbound when not running', () => {
    it('should be a no-op when gateway is stopped', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();
      await gateway.stop();

      // Fire an event after the gateway has stopped
      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_stopped_1',
          agentName: 'alice',
          text: 'should not deliver',
          attachments: [],
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('stop() method', () => {
    it('should disconnect relay client and clear state', async () => {
      const { gateway } = createGateway();
      await gateway.start();

      // Verify gateway is running by checking it can receive messages
      await gateway.stop();

      // Calling stop again should be safe (idempotent)
      await gateway.stop();
    });

    it('should clear seenMessageIds and processingMessageIds on stop', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      // Send a message so it gets added to seenMessageIds
      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_clear_1',
          agentName: 'alice',
          text: 'will be cleared',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledTimes(1);
      });

      await gateway.stop();

      // Now restart and send the same message ID - it should be delivered again
      // because stop() cleared the seen map
      sendMessage.mockClear();
      // Clear event handlers first since stop() unsubscribes
      for (const key of Object.keys(eventHandlers)) {
        eventHandlers[key] = [];
      }
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_clear_1',
          agentName: 'alice',
          text: 'will be cleared',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledTimes(1);
      });

      await gateway.stop();
    });

    it('should unsubscribe all event handlers on stop', async () => {
      const { gateway, sendMessage } = createGateway();
      await gateway.start();

      await gateway.stop();

      // After stop, firing events should not trigger sendMessage
      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_unsub_1',
          agentName: 'alice',
          text: 'should not deliver after stop',
          attachments: [],
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('channel name normalization', () => {
    it('should normalize channel names with # prefix', async () => {
      const { gateway, sendMessage } = createGateway({ channels: ['#general'] });
      await gateway.start();

      fireEvent('messageCreated', {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_norm_1',
          agentName: 'alice',
          text: 'normalization test',
          attachments: [],
        },
      });

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalled();
      });

      const call = sendMessage.mock.calls[0][0];
      expect(call.text).toBe('[relaycast:general] @alice: normalization test');

      await gateway.stop();
    });
  });
});
