import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WsType } from 'ws';

// Mock spawn/manager and relaycast SDK to prevent side-effects from gateway.ts module load
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

vi.mock('@relaycast/sdk', () => ({
  RelayCast: vi.fn().mockImplementation(() => ({
    agents: { registerOrGet: vi.fn().mockResolvedValue({ name: 'test', token: 'tok' }) },
    as: vi.fn().mockReturnValue({
      connect: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      on: {
        connected: vi.fn().mockReturnValue(() => {}),
        messageCreated: vi.fn().mockReturnValue(() => {}),
        threadReply: vi.fn().mockReturnValue(() => {}),
        dmReceived: vi.fn().mockReturnValue(() => {}),
        groupDmReceived: vi.fn().mockReturnValue(() => {}),
        commandInvoked: vi.fn().mockReturnValue(() => {}),
        reactionAdded: vi.fn().mockReturnValue(() => {}),
        reactionRemoved: vi.fn().mockReturnValue(() => {}),
        reconnecting: vi.fn().mockReturnValue(() => {}),
        disconnected: vi.fn().mockReturnValue(() => {}),
        error: vi.fn().mockReturnValue(() => {}),
      },
    }),
  })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('{"spawns":[]}'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

import { OpenClawGatewayClient } from '../gateway.js';

// ---------------------------------------------------------------------------
// Mock OpenClaw Gateway WebSocket Server
// ---------------------------------------------------------------------------

interface MockServerOptions {
  /** Whether to accept or reject auth. Default: true */
  acceptAuth?: boolean;
  /** Delay before sending challenge (ms). 0 = immediate. */
  challengeDelay?: number;
  /** Whether to send a challenge at all. Default: true */
  sendChallenge?: boolean;
  /** Delay before responding to chat.send RPCs (ms). Default: 0 */
  chatDelay?: number;
  /** Whether chat.send succeeds. Default: true */
  chatOk?: boolean;
}

class MockOpenClawServer {
  private wss: WebSocketServer;
  private clients: Set<WsType> = new Set();
  port = 0;

  private acceptAuth: boolean;
  private challengeDelay: number;
  private sendChallenge: boolean;
  private chatDelay: number;
  private chatOk: boolean;

  constructor(options: MockServerOptions = {}) {
    this.acceptAuth = options.acceptAuth ?? true;
    this.challengeDelay = options.challengeDelay ?? 0;
    this.sendChallenge = options.sendChallenge ?? true;
    this.chatDelay = options.chatDelay ?? 0;
    this.chatOk = options.chatOk ?? true;

    this.wss = new WebSocketServer({ port: 0 });
    this.port = (this.wss.address() as { port: number }).port;

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));

      if (this.sendChallenge) {
        const challenge = JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'test-nonce-123', ts: Date.now() },
        });

        if (this.challengeDelay > 0) {
          setTimeout(() => ws.send(challenge), this.challengeDelay);
        } else {
          ws.send(challenge);
        }
      }

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;

        // Handle connect request
        if (msg.method === 'connect' && msg.id === 'connect-1') {
          if (this.acceptAuth) {
            ws.send(JSON.stringify({ type: 'res', id: 'connect-1', ok: true }));
          } else {
            ws.send(
              JSON.stringify({
                type: 'res',
                id: 'connect-1',
                ok: false,
                error: { code: 'auth_failed', message: 'Invalid token' },
              })
            );
          }
          return;
        }

        // Handle chat.send RPC
        if (msg.method === 'chat.send') {
          const respond = () => {
            if (this.chatOk) {
              ws.send(
                JSON.stringify({
                  type: 'res',
                  id: msg.id,
                  ok: true,
                  payload: { runId: 'run-1', status: 'accepted' },
                })
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: 'res',
                  id: msg.id,
                  ok: false,
                  error: { code: 'rate_limited', message: 'Too many requests' },
                })
              );
            }
          };

          if (this.chatDelay > 0) {
            setTimeout(respond, this.chatDelay);
          } else {
            respond();
          }
        }
      });
    });
  }

  /** Force-close all connected clients. */
  closeAllClients(code = 1000): void {
    for (const ws of this.clients) {
      ws.close(code);
    }
  }

  async close(): Promise<void> {
    this.closeAllClients();
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenClawGatewayClient', () => {
  let server: MockOpenClawServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('should connect and authenticate (happy path)', async () => {
    server = new MockOpenClawServer();
    const client = new OpenClawGatewayClient('test-token', server.port);

    await client.connect();
    // Should resolve without throwing
    await client.disconnect();
  });

  it('should reject when auth is rejected', async () => {
    server = new MockOpenClawServer({ acceptAuth: false });
    const client = new OpenClawGatewayClient('bad-token', server.port);

    await expect(client.connect()).rejects.toThrow(/auth failed/i);
    await client.disconnect();
  });

  it('should no-op when already connected', async () => {
    server = new MockOpenClawServer();
    const client = new OpenClawGatewayClient('test-token', server.port);

    await client.connect();
    // Second connect should be a no-op (early return)
    await client.connect();
    await client.disconnect();
  });

  it('should timeout when no challenge is sent', async () => {
    server = new MockOpenClawServer({ sendChallenge: false });
    const client = new OpenClawGatewayClient('test-token', server.port);

    // Monkey-patch the timeout to be short for the test
    (OpenClawGatewayClient as unknown as Record<string, number>).CONNECT_TIMEOUT_MS = 200;

    await expect(client.connect()).rejects.toThrow(/timed out/i);
    await client.disconnect();

    // Restore
    (OpenClawGatewayClient as unknown as Record<string, number>).CONNECT_TIMEOUT_MS = 30_000;
  });

  it('should reject connect when WS closes before auth', async () => {
    server = new MockOpenClawServer({ sendChallenge: false });
    const client = new OpenClawGatewayClient('test-token', server.port);

    // Start connecting, then close server connections immediately
    const connectPromise = client.connect();
    // Give the WS time to establish before closing
    await new Promise((r) => setTimeout(r, 50));
    server.closeAllClients(1000);

    await expect(connectPromise).rejects.toThrow(/closed before authentication|timed out/i);
    await client.disconnect();
  });

  it('should return true on successful sendChatMessage', async () => {
    server = new MockOpenClawServer();
    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();

    const result = await client.sendChatMessage('hello world');
    expect(result).toBe(true);

    await client.disconnect();
  });

  it('should pass idempotencyKey in sendChatMessage params', async () => {
    let receivedParams: Record<string, unknown> = {};
    server = new MockOpenClawServer();

    // Intercept the server to capture params
    const origWss = (server as unknown as { wss: WebSocketServer }).wss;
    const origListeners = origWss.listeners('connection');
    origWss.removeAllListeners('connection');
    origWss.on('connection', (ws) => {
      // Re-emit for original handler
      for (const listener of origListeners) {
        (listener as (ws: WsType) => void)(ws);
      }
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.method === 'chat.send') {
          receivedParams = msg.params as Record<string, unknown>;
        }
      });
    });

    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();

    await client.sendChatMessage('test', 'idem-key-123');
    expect(receivedParams.idempotencyKey).toBe('idem-key-123');

    await client.disconnect();
  });

  it('should return false on RPC error', async () => {
    server = new MockOpenClawServer({ chatOk: false });
    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();

    const result = await client.sendChatMessage('hello');
    expect(result).toBe(false);

    await client.disconnect();
  });

  it('should return false on sendChatMessage when not connected', async () => {
    // No server at all — connect should fail
    const client = new OpenClawGatewayClient('test-token', 1);

    const result = await client.sendChatMessage('hello');
    expect(result).toBe(false);

    await client.disconnect();
  });

  it('should reject pending RPCs on disconnect', async () => {
    // Use a server that never responds to chat.send
    server = new MockOpenClawServer();
    // Override: don't respond to chat.send
    const origWss = (server as unknown as { wss: WebSocketServer }).wss;
    origWss.removeAllListeners('connection');
    origWss.on('connection', (ws) => {
      // Send challenge
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce-1', ts: Date.now() },
        })
      );
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: 'connect-1', ok: true }));
        }
        // Deliberately don't respond to chat.send
      });
    });

    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();

    // Send a message that won't get a response
    const chatPromise = client.sendChatMessage('will be rejected');

    // Disconnect while the RPC is pending
    await client.disconnect();

    const result = await chatPromise;
    expect(result).toBe(false);
  });

  it('should not reconnect after disconnect()', async () => {
    server = new MockOpenClawServer();
    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();
    await client.disconnect();

    // After disconnect, the stopped flag should prevent reconnection.
    // Verify by checking that sendChatMessage returns false without hanging.
    const result = await client.sendChatMessage('should fail');
    expect(result).toBe(false);
  });

  it('should handle non-JSON messages gracefully', async () => {
    server = new MockOpenClawServer({ sendChallenge: false });
    const origWss = (server as unknown as { wss: WebSocketServer }).wss;
    origWss.removeAllListeners('connection');
    origWss.on('connection', (ws) => {
      // Send garbage first, then a proper challenge
      ws.send('not json at all');
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce-2', ts: Date.now() },
        })
      );
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: 'connect-1', ok: true }));
        }
      });
    });

    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();
    await client.disconnect();
  });

  it('should fallback to alternate payload version on signature rejection', async () => {
    let connectAttempts = 0;
    server = new MockOpenClawServer({ sendChallenge: false });
    const origWss = (server as unknown as { wss: WebSocketServer }).wss;
    origWss.removeAllListeners('connection');
    origWss.on('connection', (ws) => {
      connectAttempts++;
      // Send challenge
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: `nonce-fallback-${connectAttempts}`, ts: Date.now() },
        })
      );
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.method === 'connect') {
          if (connectAttempts === 1) {
            // First attempt: reject with signature invalid
            ws.send(
              JSON.stringify({
                type: 'res',
                id: 'connect-1',
                ok: false,
                error: { code: 'auth_failed', message: 'device signature invalid' },
              })
            );
          } else {
            // Second attempt (fallback): accept
            ws.send(JSON.stringify({ type: 'res', id: 'connect-1', ok: true }));
          }
        }
      });
    });

    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();
    // Should have connected on the fallback attempt
    expect(connectAttempts).toBe(2);
    await client.disconnect();
  });

  it('should not retry fallback more than once', async () => {
    let connectAttempts = 0;
    server = new MockOpenClawServer({ sendChallenge: false });
    const origWss = (server as unknown as { wss: WebSocketServer }).wss;
    origWss.removeAllListeners('connection');
    origWss.on('connection', (ws) => {
      connectAttempts++;
      ws.send(
        JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: `nonce-nofallback-${connectAttempts}`, ts: Date.now() },
        })
      );
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.method === 'connect') {
          // Always reject with signature invalid
          ws.send(
            JSON.stringify({
              type: 'res',
              id: 'connect-1',
              ok: false,
              error: { code: 'auth_failed', message: 'device signature invalid' },
            })
          );
        }
      });
    });

    const client = new OpenClawGatewayClient('test-token', server.port);
    await expect(client.connect()).rejects.toThrow(/auth failed|signature invalid|closed before/i);
    // Should have tried exactly 2 times: primary + one fallback
    expect(connectAttempts).toBe(2);
    await client.disconnect();
  });

  it('should silently ignore unrecognized event messages', async () => {
    server = new MockOpenClawServer();
    const origWss = (server as unknown as { wss: WebSocketServer }).wss;
    const origListeners = origWss.listeners('connection');
    origWss.removeAllListeners('connection');
    origWss.on('connection', (ws) => {
      for (const listener of origListeners) {
        (listener as (ws: WsType) => void)(ws);
      }
      // Send some random event after auth
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'event', event: 'chat.tick', payload: {} }));
      }, 100);
    });

    const client = new OpenClawGatewayClient('test-token', server.port);
    await client.connect();
    await new Promise((r) => setTimeout(r, 150));
    await client.disconnect();
  });
});
