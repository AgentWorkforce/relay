import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
    any: registerHandler('any'),
  },
};

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => ({
    agents: {
      registerOrGet: vi.fn().mockResolvedValue({ name: 'test-claw', token: 'tok_test' }),
    },
    channels: { join: vi.fn().mockResolvedValue({ ok: true }) },
    messages: { list: vi.fn().mockResolvedValue([]) },
    as: vi.fn().mockReturnValue(mockAgentClient),
  })),
}));

const mockSpawnManager = {
  size: 0,
  spawn: vi.fn(),
  release: vi.fn(),
  releaseByName: vi.fn(),
  releaseAll: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockReturnValue([]),
  get: vi.fn(),
};

vi.mock('../spawn/manager.js', () => ({
  SpawnManager: vi.fn().mockImplementation(() => mockSpawnManager),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{"spawns":[]}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// We do NOT mock node:http — we want a real HTTP server for these tests.
// But we need to intercept createServer in InboundGateway so we can control the port.
// Strategy: let gateway start its own server, then hit it via fetch().

// We need to override RELAYCAST_CONTROL_PORT to use port 0 (random)
// Actually, we can't use port 0 because the gateway hardcodes the listen call.
// Instead, let's mock node:http to capture the request handler, then run a real server.

let capturedHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
let realServer: HttpServer | null = null;
let controlPort = 0;

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: vi.fn((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      capturedHandler = handler;
      // Create a real HTTP server with the captured handler
      realServer = actual.createServer(handler);
      return {
        listen: vi.fn((_port: number, _host: string, cb: () => void) => {
          // Bind to random port
          realServer!.listen(0, '127.0.0.1', () => {
            const addr = realServer!.address() as { port: number };
            controlPort = addr.port;
            cb();
          });
        }),
        close: vi.fn((cb?: () => void) => {
          realServer?.close(() => cb?.());
        }),
        address: vi.fn(() => realServer?.address()),
        on: vi.fn((_event: string, _handler: (...args: unknown[]) => void) => {}),
      };
    }),
  };
});

import { InboundGateway } from '../gateway.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchControl(method: string, path: string, body?: unknown): Promise<Response> {
  const url = `http://127.0.0.1:${controlPort}${path}`;
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  return fetch(url, opts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gateway control HTTP server', () => {
  let gateway: InboundGateway;

  beforeEach(async () => {
    vi.clearAllMocks();
    for (const key of Object.keys(eventHandlers)) {
      eventHandlers[key] = [];
    }
    // Reset mock spawn manager state
    mockSpawnManager.size = 0;
    mockSpawnManager.spawn.mockReset();
    mockSpawnManager.release.mockReset();
    mockSpawnManager.releaseByName.mockReset();
    mockSpawnManager.list.mockReturnValue([]);

    gateway = new InboundGateway({
      config: {
        apiKey: 'rk_live_test',
        clawName: 'test-claw',
        baseUrl: 'https://api.relaycast.dev',
        channels: ['general'],
      },
      relaySender: { sendMessage: vi.fn().mockResolvedValue({ event_id: 'evt_1' }) },
    });
    await gateway.start();
  });

  afterEach(async () => {
    await gateway.stop();
    if (realServer) {
      realServer.close();
      realServer = null;
    }
  });

  it('GET /health returns 200', async () => {
    const res = await fetchControl('GET', '/health');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.status).toBe('running');
    expect(typeof data.uptime).toBe('number');
  });

  it('POST /spawn with name returns 200', async () => {
    mockSpawnManager.spawn.mockResolvedValue({
      id: 'spawn-1',
      displayName: 'worker-1',
      agentName: 'claw-ws-worker-1',
      gatewayPort: 18800,
    });
    mockSpawnManager.size = 1;

    const res = await fetchControl('POST', '/spawn', {
      name: 'worker-1',
      role: 'researcher',
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.name).toBe('worker-1');
    expect(data.agentName).toBe('claw-ws-worker-1');
    expect(data.id).toBe('spawn-1');
  });

  it('POST /spawn without name returns 400', async () => {
    const res = await fetchControl('POST', '/spawn', { role: 'worker' });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/name/i);
  });

  it('POST /spawn error returns 500', async () => {
    mockSpawnManager.spawn.mockRejectedValue(new Error('Docker unavailable'));

    const res = await fetchControl('POST', '/spawn', { name: 'worker-1' });
    expect(res.status).toBe(500);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Docker unavailable');
  });

  it('GET /list returns 200 with empty list', async () => {
    mockSpawnManager.list.mockReturnValue([]);

    const res = await fetchControl('GET', '/list');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.active).toBe(0);
    expect(data.claws).toEqual([]);
  });

  it('GET /list returns handles', async () => {
    mockSpawnManager.list.mockReturnValue([
      { id: 's1', displayName: 'alpha', agentName: 'claw-alpha', gatewayPort: 18801 },
    ]);

    const res = await fetchControl('GET', '/list');
    expect(res.status).toBe(200);
    const data = await res.json() as { claws: Array<{ name: string }> };
    expect(data.claws).toHaveLength(1);
    expect(data.claws[0].name).toBe('alpha');
  });

  it('POST /release by name returns 200', async () => {
    mockSpawnManager.releaseByName.mockResolvedValue(true);
    mockSpawnManager.size = 0;

    const res = await fetchControl('POST', '/release', { name: 'worker-1' });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it('POST /release by id returns 200', async () => {
    mockSpawnManager.release.mockResolvedValue(true);
    mockSpawnManager.size = 0;

    const res = await fetchControl('POST', '/release', { id: 'spawn-1' });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it('POST /release without name or id returns 400', async () => {
    const res = await fetchControl('POST', '/release', {});
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/name.*id|id.*name/i);
  });

  it('POST /release error returns 500', async () => {
    mockSpawnManager.release.mockRejectedValue(new Error('Process kill failed'));

    const res = await fetchControl('POST', '/release', { id: 'spawn-1' });
    expect(res.status).toBe(500);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Process kill failed');
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetchControl('GET', '/nonexistent');
    expect(res.status).toBe(404);
    const data = await res.json() as Record<string, unknown>;
    expect(data.error).toBe('Not found');
  });
});
