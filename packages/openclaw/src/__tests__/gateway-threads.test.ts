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
});
