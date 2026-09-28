import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import {
  claudePeerFrames,
  DeliveryDrainer,
  DeliveryLedger,
  injectClaudeTerminal,
  injectCodex,
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

// Plain Node-only CI does not build or install a broker binary. Exercise the
// same journal-lock handshake and cross-process exclusion with a scripted
// helper, matching the established integration-cleanup-journal test fixture.
const originalBrokerBinaryPath = process.env.BROKER_BINARY_PATH;
const lockHelperDirectory = mkdtempSync(path.join(os.tmpdir(), 'on-relay-lock-helper-'));
const lockHelperPath = path.join(lockHelperDirectory, 'fake-broker.cjs');
writeFileSync(
  lockHelperPath,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv;
const lock = args[args.indexOf('--file') + 1];
const timeoutMs = Number(args[args.indexOf('--timeout-ms') + 1] || 5000);
const mutex = lock + '.test-mutex';
const deadline = Date.now() + timeoutMs;
(function acquire() {
  try {
    fs.mkdirSync(mutex);
  } catch {
    if (Date.now() >= deadline) process.exit(4);
    return setTimeout(acquire, 10);
  }
  process.on('exit', () => {
    try { fs.rmdirSync(mutex); } catch {}
  });
  process.stdout.write('locked\\n');
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
})();
`,
  { mode: 0o755 }
);
process.env.BROKER_BINARY_PATH = lockHelperPath;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'on-relay-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

const passthroughTestLock = async <T>(action: () => Promise<T>): Promise<T> => action();

function serializedTestLock(): <T>(action: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return async <T>(action: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  };
}

function testLedger(filePath: string, lock = passthroughTestLock): DeliveryLedger {
  return new DeliveryLedger(filePath, lock);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

afterAll(async () => {
  if (originalBrokerBinaryPath === undefined) delete process.env.BROKER_BINARY_PATH;
  else process.env.BROKER_BINARY_PATH = originalBrokerBinaryPath;
  await rm(lockHelperDirectory, { recursive: true });
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

describe('durable at-most-once drain', () => {
  it('serializes listing through acknowledgement for listeners sharing a ledger', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'ledger.json');
    const lock = serializedTestLock();
    let queued = true;
    const list = vi.fn(async () => ({ items: queued ? [delivery()] : [] }));
    const ack = vi.fn(async () => {
      queued = false;
    });
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const relay = { inbox: { list, ack, fail: async () => ({}), defer: async () => ({}) } };
    const options = {
      relay,
      injector,
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    };
    const first = new DeliveryDrainer({
      ...options,
      ledger: testLedger(filePath, lock),
    });
    const second = new DeliveryDrainer({
      ...options,
      ledger: testLedger(filePath, lock),
    });

    await Promise.all([first.drainOnce(), second.drainOnce()]);

    expect(list).toHaveBeenCalledTimes(2);
    expect(injector).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it('does not handle future or malformed scheduled deliveries', async () => {
    const directory = await temporaryDirectory();
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const ack = vi.fn(async () => ({}));
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({
            items: [
              delivery({ id: 'queued-future', availableAt: '2999-01-01T00:00:00.000Z' }),
              delivery({ id: 'deferred-invalid', state: 'deferred', availableAt: 'not-a-date' }),
              delivery({ id: 'deferred-missing', state: 'deferred', availableAt: undefined }),
            ],
          }),
          ack,
          fail: async () => ({}),
          defer: async () => ({}),
        },
      },
      ledger: testLedger(path.join(directory, 'ledger.json')),
      injector,
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });

    await drainer.drainOnce();

    expect(injector).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('persists injection before ACK and retries a lost ACK without reinjecting', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'ledger.json');
    const ledger = testLedger(filePath);
    await ledger.load();
    const item = delivery();
    const list = vi.fn(async () => ({ items: [item] }));
    const ack = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({});
    const fail = vi.fn(async () => ({}));
    const defer = vi.fn(async () => ({}));
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const drainer = new DeliveryDrainer({
      relay: { inbox: { list, ack, fail, defer } },
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
    expect(ledger.get('del_1')).toBeUndefined();
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as {
      deliveries: Record<string, { state: string }>;
    };
    expect(persisted.deliveries.del_1).toBeUndefined();
  });

  it('never resends an in-flight delivery recovered after a crash', async () => {
    const directory = await temporaryDirectory();
    const ledger = testLedger(path.join(directory, 'ledger.json'));
    await ledger.record('del_1', 'injecting');
    const ack = vi.fn(async () => ({}));
    const fail = vi.fn(async () => ({}));
    const defer = vi.fn(async () => ({}));
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const drainer = new DeliveryDrainer({
      relay: { inbox: { list: async () => ({ items: [delivery()] }), ack, fail, defer } },
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
    const ledger = testLedger(path.join(directory, 'ledger.json'));
    const ack = vi.fn(async () => ({}));
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({ items: [delivery({ metadata: { reason: 'channel' } })] }),
          ack,
          fail: async () => ({}),
          defer: async () => ({}),
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

  it('injects the canonical thread_reply delivery reason', async () => {
    const directory = await temporaryDirectory();
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const ack = vi.fn(async () => ({}));
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({ items: [delivery({ metadata: { reason: 'thread_reply' } })] }),
          ack,
          fail: async () => ({}),
          defer: async () => ({}),
        },
      },
      ledger: testLedger(path.join(directory, 'ledger.json')),
      injector,
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    await drainer.drainOnce();
    expect(injector).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
  });

  it('continues a batch when one acknowledgement fails', async () => {
    const directory = await temporaryDirectory();
    const first = delivery({ id: 'del_1', metadata: { reason: 'channel' } });
    const second = delivery({ id: 'del_2', metadata: { reason: 'channel' } });
    const ack = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({ items: [first, second] }),
          ack,
          fail: async () => ({}),
          defer: async () => ({}),
        },
      },
      ledger: testLedger(path.join(directory, 'ledger.json')),
      injector: vi.fn(async () => ({ kind: 'injected' as const })),
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    await drainer.drainOnce();
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it('defers a retrying item so it cannot pin the finite inbox page', async () => {
    const directory = await temporaryDirectory();
    const defer = vi.fn(async () => ({}));
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({ items: [delivery()] }),
          ack: async () => ({}),
          fail: async () => ({}),
          defer,
        },
      },
      ledger: testLedger(path.join(directory, 'ledger.json')),
      injector: vi.fn(async () => ({ kind: 'retry' as const, reason: 'session busy' })),
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    await drainer.drainOnce();
    expect(defer).toHaveBeenCalledWith(
      expect.objectContaining({ inboxItemId: 'del_1', reason: 'session busy' })
    );
  });

  it('terminally fails a deterministic rejection and clears its barrier', async () => {
    const directory = await temporaryDirectory();
    const ledger = testLedger(path.join(directory, 'ledger.json'));
    const fail = vi.fn(async () => ({}));
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({ items: [delivery()] }),
          ack: async () => ({}),
          fail,
          defer: async () => ({}),
        },
      },
      ledger,
      injector: vi.fn(async () => ({ kind: 'rejected' as const, reason: 'too large' })),
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    await drainer.drainOnce();
    expect(fail).toHaveBeenCalledWith({ inboxItemId: 'del_1', error: 'too large', retry: false });
    expect(ledger.get('del_1')).toBeUndefined();
  });

  it('does not commit an in-memory barrier when persistence fails', async () => {
    const directory = await temporaryDirectory();
    const blockedParent = path.join(directory, 'not-a-directory');
    await writeFile(blockedParent, 'blocked');
    const ledger = testLedger(path.join(blockedParent, 'ledger.json'));
    await expect(ledger.record('del_1', 'injecting')).rejects.toThrow();
    expect(ledger.get('del_1')).toBeUndefined();
  });

  it('suppresses normalized self-sent deliveries', async () => {
    const directory = await temporaryDirectory();
    const injector = vi.fn(async () => ({ kind: 'injected' as const }));
    const ack = vi.fn(async () => ({}));
    const drainer = new DeliveryDrainer({
      relay: {
        inbox: {
          list: async () => ({
            items: [delivery({ message: { id: 'msg_1', text: 'echo', from: { name: '@Reviewer' } } })],
          }),
          ack,
          fail: async () => ({}),
          defer: async () => ({}),
        },
      },
      ledger: testLedger(path.join(directory, 'ledger.json')),
      injector,
      agentName: 'reviewer',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });
    await drainer.drainOnce();
    expect(injector).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });
});

describe('Codex injection', () => {
  it('rejects messages too large for a portable argv entry before spawning', async () => {
    await expect(
      injectCodex({
        text: 'x'.repeat(120_001),
        messageId: 'msg_1',
        sessionId: '11111111-1111-4111-8111-111111111111',
      })
    ).resolves.toEqual(expect.objectContaining({ kind: 'rejected' }));
  });
});

describe('Claude injection', () => {
  it('refuses a peer key that is not bound to the live process instance', async () => {
    const registryDir = await temporaryDirectory();
    const sessionId = '22222222-2222-4222-8222-222222222222';
    await writeFile(
      path.join(registryDir, 'session.json'),
      JSON.stringify({
        sessionId,
        pid: process.pid,
        messagingSocketPath: path.join(registryDir, 'session.sock'),
        peerProtocol: 1,
      })
    );
    await writeFile(
      path.join(registryDir, `${process.pid}.stale.key`),
      JSON.stringify({ peerToken: 'stale-token' })
    );

    await expect(
      injectClaudeTerminal({ text: 'hello', messageId: 'msg_1', sessionId }, { registryDir, env: {} })
    ).resolves.toEqual({ kind: 'retry', reason: 'Claude Code inbox key is unavailable' });
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
