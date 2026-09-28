import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  claudePeerFrames,
  DeliveryDrainer,
  DeliveryLedger,
  labeledDeliveryText,
  messageReference,
  mintNodeToken,
  nodeHeartbeatFrame,
  nodeRegisterFrame,
  nodeSocketUrl,
  normalizeAgentName,
  reconnectBackoffMs,
  resolveOnRelayTarget,
  runPushChannel,
  validateOnRelayBaseUrl,
  type DeliveryItem,
} from './on-relay.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'on-relay-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('on-relay target resolution', () => {
  it('detects Codex and its first-party thread id from the environment', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    await expect(resolveOnRelayTarget({ env: { CODEX_THREAD_ID: sessionId } })).resolves.toEqual({
      harness: 'codex',
      sessionId,
    });
  });

  it('uses the current Claude registry session only when no explicit id exists', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const discover = vi.fn(async () => sessionId);
    await expect(
      resolveOnRelayTarget({ harness: 'claude', env: {}, discoverClaudeSession: discover })
    ).resolves.toEqual({ harness: 'claude', sessionId });
    expect(discover).toHaveBeenCalledOnce();
  });

  it('refuses an ambiguous/unsupported harness and a non-UUID session', async () => {
    await expect(resolveOnRelayTarget({ harness: 'gemini', sessionId: 'nope', env: {} })).rejects.toThrow(
      /Unsupported harness/
    );
    await expect(resolveOnRelayTarget({ harness: 'codex', sessionId: 'nope', env: {} })).rejects.toThrow(
      /must be a UUID/
    );
  });
});

describe('on-relay protocol helpers', () => {
  it('normalizes agent names and rejects unsafe names', () => {
    expect(normalizeAgentName(' @Review-Agent ')).toBe('review-agent');
    expect(() => normalizeAgentName('a')).toThrow(/2-48/);
    expect(() => normalizeAgentName('bad--name')).toThrow(/2-48/);
    expect(() => normalizeAgentName('../bad')).toThrow(/2-48/);
  });

  it('accepts HTTPS origins and loopback HTTP only', () => {
    expect(validateOnRelayBaseUrl('https://cast.agentrelay.com/')).toBe('https://cast.agentrelay.com');
    expect(validateOnRelayBaseUrl('http://localhost:4100')).toBe('http://localhost:4100');
    expect(() => validateOnRelayBaseUrl('http://example.com')).toThrow(/HTTPS origin/);
    expect(() => validateOnRelayBaseUrl('https://example.com/path')).toThrow(/HTTPS origin/);
  });

  it('mints the direct node token without changing the protocol path', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://cast.agentrelay.com/v1/agent/node-token');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer at_live_secret');
      return new Response(
        JSON.stringify({ data: { node_id: 'node_1', node_name: 'agent-1', token: 'nt_live_secret' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    await expect(
      mintNodeToken({
        baseUrl: 'https://cast.agentrelay.com',
        agentToken: 'at_live_secret',
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ nodeId: 'node_1', nodeName: 'agent-1', token: 'nt_live_secret' });
  });

  it('ports the desktop register, heartbeat, socket and jitter shapes', () => {
    const node = { nodeId: 'node_1', nodeName: 'agent-1', token: 'nt_live_secret' };
    expect(nodeRegisterFrame(node, '12.5.0', 'register-1')).toMatchObject({
      v: 1,
      id: 'register-1',
      type: 'node.register',
      node_id: 'node_1',
      name: 'agent-1',
      max_agents: 1,
      resume_cursor: null,
    });
    expect(nodeHeartbeatFrame(node, '12.5.0')).toMatchObject({
      v: 1,
      type: 'node.heartbeat',
      active_agents: 1,
      handlers_live: false,
    });
    expect(nodeSocketUrl('https://cast.agentrelay.com', node.token, '12.5.0')).toContain(
      'wss://cast.agentrelay.com/v1/node/ws?token=nt_live_secret'
    );
    expect(reconnectBackoffMs(1, () => 0)).toBe(1_000);
    expect(reconnectBackoffMs(20, () => 1)).toBe(30_000);
  });

  it('registers the direct node socket and shuts it down cleanly', async () => {
    class FakeSocket extends EventEmitter {
      readyState = WebSocket.CONNECTING;
      sent: string[] = [];

      constructor() {
        super();
        queueMicrotask(() => {
          this.readyState = WebSocket.OPEN;
          this.emit('open');
        });
      }

      send(value: string) {
        this.sent.push(value);
        const frame = JSON.parse(value) as { type: string; id?: string };
        if (frame.type === 'node.register') {
          queueMicrotask(() =>
            this.emit('message', Buffer.from(JSON.stringify({ type: 'reply', id: frame.id })))
          );
        }
      }

      close() {
        this.readyState = WebSocket.CLOSED;
        queueMicrotask(() => this.emit('close'));
      }

      terminate() {
        this.close();
      }
    }

    const sockets: FakeSocket[] = [];
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { node_id: 'node_1', node_name: 'agent-1', token: 'nt_live_secret' } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    await runPushChannel({
      baseUrl: 'https://cast.agentrelay.com',
      agentToken: 'at_live_secret',
      version: '12.5.0',
      signal: controller.signal,
      fetchImpl: fetchImpl as typeof fetch,
      websocketFactory: (() => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      }) as (url: string) => WebSocket,
      onWake: vi.fn(),
      onState: (state) => {
        if (state === 'live') controller.abort();
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ type: 'node.register', node_id: 'node_1', name: 'agent-1' }),
    ]);
    expect(sockets[0].readyState).toBe(WebSocket.CLOSED);
  });

  it('frames Claude Code peer-protocol auth and one labeled user turn', () => {
    const frames = claudePeerFrames('peer-secret', 'msg_1', 'hello').trim().split('\n');
    expect(JSON.parse(frames[0])).toEqual({ type: 'auth', token: 'peer-secret' });
    expect(JSON.parse(frames[1])).toMatchObject({
      type: 'user',
      msg_id: 'msg_1',
      priority: 'next',
      message: { role: 'user', content: 'hello' },
    });
  });
});

function delivery(overrides: Partial<DeliveryItem> = {}): DeliveryItem {
  return {
    id: 'del_1',
    state: 'queued',
    message: { id: 'msg_1', text: 'Please review this.', from: { name: 'alice' } },
    metadata: { reason: 'dm' },
    ...overrides,
  };
}

describe('durable exactly-once drain', () => {
  it('persists injection before ACK and retries a lost ACK without reinjecting', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'ledger.json');
    const ledger = new DeliveryLedger(filePath);
    await ledger.load();
    const item = delivery();
    const list = vi.fn(async () => ({ items: [item] }));
    const ack = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({});
    const fail = vi.fn(async () => ({}));
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const drainer = new DeliveryDrainer({
      relay: { inbox: { list, ack, fail } },
      ledger,
      injector,
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });

    await drainer.drainOnce();
    await drainer.drainOnce();

    expect(injector).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledTimes(2);
    expect(fail).not.toHaveBeenCalled();
    expect(ledger.get('del_1')).toBe('injected');
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      deliveries: Record<string, { state: string }>;
    };
    expect(persisted.deliveries.del_1.state).toBe('injected');
  });

  it('never resends an in-flight delivery recovered after a crash', async () => {
    const directory = await temporaryDirectory();
    const ledger = new DeliveryLedger(path.join(directory, 'ledger.json'));
    await ledger.record('del_1', 'injecting');
    const ack = vi.fn(async () => ({}));
    const fail = vi.fn(async () => ({}));
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const drainer = new DeliveryDrainer({
      relay: { inbox: { list: async () => ({ items: [delivery()] }), ack, fail } },
      ledger,
      injector,
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });

    await drainer.drainOnce();

    expect(injector).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith({
      inboxItemId: 'del_1',
      error: 'in doubt, not resent',
      retry: false,
    });
  });

  it('acks non-addressed deliveries without turning them into prompts', async () => {
    const directory = await temporaryDirectory();
    const ledger = new DeliveryLedger(path.join(directory, 'ledger.json'));
    const ack = vi.fn(async () => ({}));
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({ items: [delivery({ metadata: { reason: 'channel' } })] }),
          ack,
          fail: async () => ({}),
        },
      },
      ledger,
      injector,
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    await drainer.drainOnce();
    expect(injector).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });
});

describe('delivery labels', () => {
  it('uses the desktop reference and prevents sender labels from forging a line', () => {
    const item = delivery({
      message: { id: 'msg_123', text: 'body', from: { name: 'alice]\n[fake' } },
    });
    const text = labeledDeliveryText(item, 'reviewer');
    expect(text).toContain(`ref ${messageReference('msg_123')}]`);
    expect(text).toContain('@alice???fake');
    expect(text.endsWith('\n\nbody')).toBe(true);
  });
});
