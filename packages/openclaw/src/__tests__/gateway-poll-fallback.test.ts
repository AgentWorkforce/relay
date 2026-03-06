import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const eventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

function registerHandler(event: string) {
  return (handler: (...args: unknown[]) => void) => {
    if (!eventHandlers[event]) eventHandlers[event] = [];
    eventHandlers[event].push(handler);
    return () => {
      eventHandlers[event] = eventHandlers[event].filter((entry) => entry !== handler);
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
  },
};

const registerOrGet = vi.fn().mockResolvedValue({ name: 'test-claw', token: 'tok_test' });
const registerOrRotate = vi.fn().mockResolvedValue({ name: 'test-claw', token: 'tok_rotated' });

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
}));

const { readFile, writeFile, rename, mkdir } = fsMocks;

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => ({
    agents: {
      registerOrGet,
      registerOrRotate,
    },
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
  ...fsMocks,
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn().mockReturnValue({
      listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
      close: vi.fn((cb?: () => void) => cb?.()),
      on: vi.fn(),
      address: vi.fn().mockReturnValue({ port: 18790 }),
    }),
  };
});

import { InboundGateway } from '../gateway.js';

function response(status: number, body: unknown, headers?: Record<string, string>) {
  const normalized = Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => normalized[name.toLowerCase()] ?? null,
    },
    json: vi.fn().mockResolvedValue(body),
  };
}

function pendingFetch(init?: RequestInit): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal | undefined;
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function createGateway() {
  const sendMessage = vi.fn().mockResolvedValue({ event_id: 'evt_out_1' });
  const gateway = new InboundGateway({
    config: {
      apiKey: 'rk_live_test',
      clawName: 'test-claw',
      baseUrl: 'http://127.0.0.1:8888',
      channels: ['general'],
      transport: {
        pollFallback: {
          enabled: true,
          wsFailureThreshold: 1,
          timeoutSeconds: 1,
          probeWs: {
            enabled: true,
            intervalMs: 5_000,
            stableGraceMs: 10,
          },
        },
      },
    },
    relaySender: { sendMessage },
  });
  return { gateway, sendMessage };
}

describe('InboundGateway poll fallback', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.stubGlobal('fetch', fetchMock);
    for (const key of Object.keys(eventHandlers)) {
      eventHandlers[key] = [];
    }
    readFile.mockReset();
    readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    writeFile.mockReset();
    writeFile.mockResolvedValue(undefined);
    rename.mockReset();
    rename.mockResolvedValue(undefined);
    mkdir.mockReset();
    mkdir.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('falls back to poll and persists the committed cursor after successful delivery', async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(200, {
          events: [
            {
              id: 'evt_poll_1',
              sequence: 1,
              timestamp: '2026-03-06T04:00:00Z',
              payload: {
                type: 'message.created',
                channel: 'general',
                message: {
                  id: 'msg_1',
                  agentName: 'alice',
                  text: 'hello from poll',
                },
              },
            },
          ],
          nextCursor: 'cursor_1',
          hasMore: false,
        })
      )
      .mockImplementation((_input, init) => pendingFetch(init));

    const { gateway, sendMessage } = createGateway();
    await gateway.start();

    fireEvent('error', new Error('proxy blocked'));

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    expect(sendMessage.mock.calls[0][0].text).toBe('[relaycast:general] @alice: hello from poll');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/messages/poll');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('cursor=0');
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('inbound-cursor.json.tmp'),
      expect.stringContaining('"cursor": "cursor_1"'),
      'utf-8'
    );

    await gateway.stop();
  });

  it('resets a stale cursor on 409 and resumes from the initial cursor', async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        cursor: 'stale_cursor',
        lastSequence: 41,
        recentEventIds: [],
        updatedAt: '2026-03-06T03:59:00Z',
      })
    );

    fetchMock
      .mockImplementationOnce(async (input) => {
        expect(String(input)).toContain('cursor=stale_cursor');
        return response(409, {});
      })
      .mockImplementationOnce(async (input) => {
        expect(String(input)).toContain('cursor=0');
        return response(200, {
          events: [
            {
              id: 'evt_poll_42',
              sequence: 42,
              timestamp: '2026-03-06T04:01:00Z',
              payload: {
                type: 'message.created',
                channel: 'general',
                message: {
                  id: 'msg_42',
                  agentName: 'alice',
                  text: 'resumed after reset',
                },
              },
            },
          ],
          nextCursor: 'cursor_42',
          hasMore: false,
        });
      })
      .mockImplementation((_input, init) => pendingFetch(init));

    const { gateway, sendMessage } = createGateway();
    await gateway.start();

    fireEvent('disconnected');

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    expect(sendMessage.mock.calls[0][0].text).toBe('[relaycast:general] @alice: resumed after reset');
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('inbound-cursor.json.tmp'),
      expect.stringContaining('"cursor": "cursor_42"'),
      'utf-8'
    );

    await gateway.stop();
  });

  it('promotes back to WS after a stable recovery window', async () => {
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce(
        response(200, {
          events: [],
          nextCursor: 'cursor_0',
          hasMore: false,
        })
      )
      .mockImplementationOnce((_input, init) => pendingFetch(init))
      .mockResolvedValueOnce(
        response(200, {
          events: [],
          nextCursor: 'cursor_0',
          hasMore: false,
        })
      )
      .mockImplementation((_input, init) => pendingFetch(init));

    const { gateway, sendMessage } = createGateway();
    await gateway.start();

    fireEvent('error', new Error('proxy blocked'));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    fireEvent('connected');
    await vi.advanceTimersByTimeAsync(1_100);

    fireEvent('messageCreated', {
      type: 'message.created',
      channel: 'general',
      message: {
        id: 'msg_ws_1',
        agentName: 'bob',
        text: 'back on ws',
      },
    });

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    expect(sendMessage.mock.calls[0][0].text).toBe('[relaycast:general] @bob: back on ws');

    await gateway.stop();
  });

  it('does not redeliver a message that was already committed in poll mode after WS recovery', async () => {
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce(
        response(200, {
          events: [
            {
              id: 'evt_poll_1',
              sequence: 1,
              timestamp: '2026-03-06T04:00:00Z',
              payload: {
                type: 'message.created',
                channel: 'general',
                message: {
                  id: 'msg_1',
                  agentName: 'alice',
                  text: 'hello from poll',
                },
              },
            },
          ],
          nextCursor: 'cursor_1',
          hasMore: false,
        })
      )
      .mockImplementationOnce((_input, init) => pendingFetch(init))
      .mockResolvedValueOnce(
        response(200, {
          events: [],
          nextCursor: 'cursor_1',
          hasMore: false,
        })
      )
      .mockImplementation((_input, init) => pendingFetch(init));

    const { gateway, sendMessage } = createGateway();
    await gateway.start();

    fireEvent('error', new Error('proxy blocked'));

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });

    fireEvent('connected');
    await vi.advanceTimersByTimeAsync(1_100);

    fireEvent('messageCreated', {
      type: 'message.created',
      channel: 'general',
      message: {
        id: 'msg_1',
        agentName: 'alice',
        text: 'hello from poll',
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await gateway.stop();
  });
});
