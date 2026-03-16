import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { WebSocketServer, WebSocket } from 'ws';

const transportModulePath = '../../communicate/transport.js';
const typesModulePath = '../../communicate/types.js';

async function loadModules() {
  const transport = await import(transportModulePath);
  const types = await import(typesModulePath);
  return { RelayTransport: transport.RelayTransport, ...types };
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

class MockServer {
  readonly apiKey = 'test-key';
  readonly workspace = 'test-workspace';

  private readonly requestLog: Array<{ method: string; path: string; json?: any; auth?: string }> = [];
  private server = createServer(this.handleRequest.bind(this));
  private wsServer = new WebSocketServer({ noServer: true });
  private wsClients: WebSocket[] = [];
  private nextAgentId = 1;
  private nextMessageId = 1;

  /** Track agent tokens from registration: token -> agentId */
  private tokenToAgentId = new Map<string, string>();

  /** Override to customize HTTP responses */
  responseOverride?: (method: string, path: string, json?: any) => { status: number; body: unknown } | undefined;

  baseUrl = '';

  constructor() {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/v1/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token');
      if (!token || !this.tokenToAgentId.has(token)) {
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(req, socket as any, head, (ws) => {
        this.wsClients.push(ws);
        this.wsServer.emit('connection', ws, req);
      });
    });
  }

  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start mock server.');
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const ws of this.wsClients) ws.close();
    this.wsServer.close();
    this.server.close();
    await once(this.server, 'close');
  }

  makeConfig() {
    return {
      workspace: this.workspace,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      autoCleanup: false,
    };
  }

  get requests() {
    return this.requestLog;
  }

  requestsFor(path: string) {
    return this.requestLog.filter((r) => r.path.includes(path));
  }

  sendToAllWs(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  onWsMessage(callback: (data: string, ws: WebSocket) => void): void {
    this.wsServer.on('connection', (ws) => {
      ws.on('message', (raw) => callback(raw.toString(), ws));
    });
  }

  private resolveAgentFromToken(request: IncomingMessage): string | undefined {
    const auth = request.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      return this.tokenToAgentId.get(token);
    }
    return undefined;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl || 'http://127.0.0.1');
    const method = request.method ?? 'GET';
    const path = url.pathname;
    const json = method === 'GET' || method === 'DELETE' ? undefined : await readJson(request);

    this.requestLog.push({ method, path, json, auth: request.headers.authorization });

    if (this.responseOverride) {
      const override = this.responseOverride(method, path, json);
      if (override) {
        sendJson(response, override.status, override.body);
        return;
      }
    }

    // POST /v1/agents — register (workspace key auth)
    if (method === 'POST' && path === '/v1/agents') {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      const agentId = `agent-${this.nextAgentId++}`;
      const token = `token-${agentId}`;
      this.tokenToAgentId.set(token, agentId);
      sendJson(response, 200, { ok: true, data: { id: agentId, name: json?.name, token, status: 'online' } });
      return;
    }

    // POST /v1/agents/disconnect — unregister (agent token auth)
    if (method === 'POST' && path === '/v1/agents/disconnect') {
      const agentId = this.resolveAgentFromToken(request);
      if (!agentId) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      // Remove token mapping
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      this.tokenToAgentId.delete(token);
      sendJson(response, 200, { ok: true });
      return;
    }

    // POST /v1/dm — send DM (agent token auth)
    if (method === 'POST' && path === '/v1/dm') {
      if (!this.resolveAgentFromToken(request)) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      const msgId = `msg-${this.nextMessageId++}`;
      sendJson(response, 201, { ok: true, data: { id: msgId, text: json?.text } });
      return;
    }

    // POST /v1/channels/{channel}/messages — channel post (agent token auth)
    const channelMatch = path.match(/^\/v1\/channels\/([^/]+)\/messages$/);
    if (method === 'POST' && channelMatch) {
      if (!this.resolveAgentFromToken(request)) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      const msgId = `msg-${this.nextMessageId++}`;
      sendJson(response, 201, { ok: true, data: { id: msgId, channel_name: channelMatch[1], text: json?.text } });
      return;
    }

    // POST /v1/messages/{id}/replies — reply (agent token auth)
    const replyMatch = path.match(/^\/v1\/messages\/([^/]+)\/replies$/);
    if (method === 'POST' && replyMatch) {
      if (!this.resolveAgentFromToken(request)) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      const msgId = `msg-${this.nextMessageId++}`;
      sendJson(response, 201, { ok: true, data: { id: msgId, text: json?.text } });
      return;
    }

    // GET /v1/inbox — inbox (agent token auth)
    if (method === 'GET' && path === '/v1/inbox') {
      if (!this.resolveAgentFromToken(request)) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, { ok: true, data: { unread_channels: [], mentions: [], unread_dms: [], recent_reactions: [] } });
      return;
    }

    // GET /v1/agents — list agents (workspace key auth)
    if (method === 'GET' && path === '/v1/agents') {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, { ok: true, data: [{ name: 'TestAgent', id: 'extra-TestAgent', status: 'online' }] });
      return;
    }

    sendJson(response, 404, { message: 'Not found' });
  }
}

async function withServer(run: (server: MockServer) => Promise<void>): Promise<void> {
  const server = new MockServer();
  await server.start();
  try {
    await run(server);
  } finally {
    await server.stop();
  }
}

// --- HTTP method tests ---

test('registerAgent sends POST /v1/agents with auth header', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('TestAgent', server.makeConfig());

    const agentId = await transport.registerAgent();

    assert.ok(agentId.startsWith('agent-'));
    assert.ok(transport.token);
    const reqs = server.requestsFor('/v1/agents').filter((r) => r.method === 'POST');
    assert.ok(reqs.length > 0);
    assert.equal(reqs[0].auth, `Bearer ${server.apiKey}`);
    assert.deepEqual(reqs[0].json, { name: 'TestAgent', type: 'agent' });
  });
});

test('unregisterAgent sends POST /v1/agents/disconnect', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('TestAgent', server.makeConfig());

    await transport.registerAgent();
    await transport.unregisterAgent();

    const disconnectReqs = server.requestsFor('/v1/agents/disconnect');
    assert.ok(disconnectReqs.some((r) => r.method === 'POST'));
    assert.equal(transport.agentId, undefined);
    assert.equal(transport.token, undefined);
  });
});

test('sendDm sends POST /v1/dm with correct payload', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Sender', server.makeConfig());

    const messageId = await transport.sendDm('Recipient', 'hello');

    assert.ok(messageId.startsWith('msg-'));
    const req = server.requestsFor('/v1/dm')[0];
    assert.deepEqual(req.json, { to: 'Recipient', text: 'hello' });
    // Agent-authenticated endpoint uses the per-agent token, not workspace key
    assert.ok(req.auth?.startsWith('Bearer token-agent-'));
  });
});

test('postMessage sends POST /v1/channels/{channel}/messages', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Poster', server.makeConfig());

    const messageId = await transport.postMessage('general', 'update');

    assert.ok(messageId.startsWith('msg-'));
    const req = server.requestsFor('/v1/channels/general/messages')[0];
    assert.deepEqual(req.json, { text: 'update' });
    assert.ok(req.auth?.startsWith('Bearer token-agent-'));
  });
});

test('reply sends POST /v1/messages/{id}/replies', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Replier', server.makeConfig());

    const messageId = await transport.reply('msg-42', 'response');

    assert.ok(messageId.startsWith('msg-'));
    const req = server.requestsFor('/v1/messages/msg-42/replies')[0];
    assert.deepEqual(req.json, { text: 'response' });
    assert.ok(req.auth?.startsWith('Bearer token-agent-'));
  });
});

test('listAgents sends GET /v1/agents', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Lister', server.makeConfig());

    const agents = await transport.listAgents();

    assert.deepEqual(agents, ['TestAgent']);
    const req = server.requestsFor('/v1/agents')[0];
    assert.equal(req.auth, `Bearer ${server.apiKey}`);
  });
});

test('checkInbox sends GET /v1/inbox', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Checker', server.makeConfig());

    const messages = await transport.checkInbox();

    assert.deepEqual(messages, []);
    assert.ok(server.requestsFor('/v1/inbox').length > 0);
  });
});

// --- Error handling tests ---

test('401 response throws RelayAuthError', async () => {
  await withServer(async (server) => {
    const { RelayTransport, RelayAuthError } = await loadModules();
    const transport = new RelayTransport('BadAuth', {
      ...server.makeConfig(),
      apiKey: 'wrong-key',
    });

    await assert.rejects(() => transport.registerAgent(), (err: any) => {
      assert.ok(err instanceof RelayAuthError);
      assert.equal(err.statusCode, 401);
      return true;
    });
  });
});

test('4xx response throws RelayConnectionError', async () => {
  await withServer(async (server) => {
    const { RelayTransport, RelayConnectionError } = await loadModules();
    server.responseOverride = (method, path) => {
      if (path === '/v1/agents') return { status: 403, body: { message: 'Forbidden' } };
      return undefined;
    };
    const transport = new RelayTransport('Forbidden', server.makeConfig());

    await assert.rejects(() => transport.listAgents(), (err: any) => {
      assert.ok(err instanceof RelayConnectionError);
      assert.equal(err.statusCode, 403);
      return true;
    });
  });
});

test('5xx response retries up to 3 times then throws', async () => {
  await withServer(async (server) => {
    const { RelayTransport, RelayConnectionError } = await loadModules();
    let attempts = 0;
    server.responseOverride = (method, path) => {
      if (path === '/v1/agents') {
        attempts++;
        return { status: 500, body: { message: 'Internal error' } };
      }
      return undefined;
    };
    const transport = new RelayTransport('RetryAgent', server.makeConfig());

    await assert.rejects(() => transport.listAgents(), (err: any) => {
      assert.ok(err instanceof RelayConnectionError);
      assert.equal(err.statusCode, 500);
      return true;
    });
    assert.equal(attempts, 3);
  });
});

test('missing apiKey throws RelayConfigError', async () => {
  const savedKey = process.env.RELAY_API_KEY;
  delete process.env.RELAY_API_KEY;
  try {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('NoKey', {
      workspace: 'test',
      baseUrl: 'http://localhost:9999',
      autoCleanup: false,
    });

    await assert.rejects(() => transport.listAgents(), (err: any) => {
      assert.equal(err.name, 'RelayConfigError');
      assert.ok(err.message.includes('RELAY_API_KEY'));
      return true;
    });
  } finally {
    if (savedKey !== undefined) process.env.RELAY_API_KEY = savedKey;
  }
});

test('missing workspace throws RelayConfigError on connect', async () => {
  const savedWorkspace = process.env.RELAY_WORKSPACE;
  delete process.env.RELAY_WORKSPACE;
  try {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('NoWorkspace', {
      apiKey: 'some-key',
      baseUrl: 'http://localhost:9999',
      autoCleanup: false,
    });

    await assert.rejects(() => transport.connect(), (err: any) => {
      assert.equal(err.name, 'RelayConfigError');
      assert.ok(err.message.includes('RELAY_WORKSPACE'));
      return true;
    });
  } finally {
    if (savedWorkspace !== undefined) process.env.RELAY_WORKSPACE = savedWorkspace;
  }
});

// --- WebSocket tests ---

test('WebSocket receives messages and dispatches to callback', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('WsAgent', server.makeConfig());
    const received: any[] = [];

    transport.onWsMessage((message: any) => {
      received.push(message);
    });

    await transport.connect();
    await sleep(50);

    server.sendToAllWs({
      type: 'message',
      sender: 'Other',
      text: 'hello ws',
      message_id: 'ws-msg-1',
    });

    await sleep(100);
    assert.equal(received.length, 1);
    assert.equal(received[0].sender, 'Other');
    assert.equal(received[0].text, 'hello ws');
    assert.equal(received[0].messageId, 'ws-msg-1');

    await transport.disconnect();
  });
});

test('WebSocket responds to ping with pong', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('PingAgent', server.makeConfig());
    const pongs: string[] = [];

    server.onWsMessage((data) => {
      const parsed = JSON.parse(data);
      if (parsed.type === 'pong') pongs.push(parsed.type);
    });

    await transport.connect();
    await sleep(50);

    server.sendToAllWs({ type: 'ping' });
    await sleep(100);

    assert.equal(pongs.length, 1);
    await transport.disconnect();
  });
});

test('WebSocket ignores non-message payloads', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('FilterAgent', server.makeConfig());
    const received: any[] = [];

    transport.onWsMessage((message: any) => {
      received.push(message);
    });

    await transport.connect();
    await sleep(50);

    server.sendToAllWs({ type: 'status', data: 'online' });
    server.sendToAllWs({ type: 'message', sender: 'Real', text: 'real message', message_id: 'r1' });
    await sleep(100);

    assert.equal(received.length, 1);
    assert.equal(received[0].text, 'real message');

    await transport.disconnect();
  });
});

test('disconnect closes WebSocket and unregisters agent', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('DisconnectAgent', server.makeConfig());

    await transport.connect();
    assert.ok(transport.agentId);
    await sleep(50);

    await transport.disconnect();

    assert.ok(server.requestsFor('/v1/agents/disconnect').some((r) => r.method === 'POST'));
  });
});

// --- URL conversion test ---

test('wsBaseUrl converts https to wss and http to ws', async () => {
  const { RelayTransport } = await loadModules();

  const httpsTransport = new RelayTransport('Agent', {
    workspace: 'test',
    apiKey: 'key',
    baseUrl: 'https://api.example.com',
    autoCleanup: false,
  });

  const httpTransport = new RelayTransport('Agent', {
    workspace: 'test',
    apiKey: 'key',
    baseUrl: 'http://localhost:8080',
    autoCleanup: false,
  });

  // Access private method via bracket notation for testing
  assert.equal((httpsTransport as any)['wsBaseUrl'](), 'wss://api.example.com');
  assert.equal((httpTransport as any)['wsBaseUrl'](), 'ws://localhost:8080');
});

// --- Auth header on all requests ---

test('all HTTP methods include Authorization header', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('AuthCheck', server.makeConfig());

    await transport.registerAgent();
    await transport.sendDm('other', 'hi');
    await transport.postMessage('general', 'msg');
    await transport.reply('msg-1', 'reply');
    await transport.checkInbox();
    await transport.listAgents();
    await transport.unregisterAgent();

    for (const req of server.requests) {
      assert.ok(req.auth?.startsWith('Bearer '), `Missing auth on ${req.method} ${req.path}`);
    }
  });
});

// --- messageFromPayload field mapping ---

test('messageFromPayload maps thread_id and message_id to camelCase', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('MapAgent', server.makeConfig());
    const received: any[] = [];

    transport.onWsMessage((message: any) => {
      received.push(message);
    });

    await transport.connect();
    await sleep(50);

    server.sendToAllWs({
      type: 'message',
      sender: 'Lead',
      text: 'threaded',
      channel: 'general',
      thread_id: 'thread-42',
      message_id: 'msg-99',
      timestamp: 1700000000,
    });

    await sleep(100);

    assert.equal(received.length, 1);
    assert.equal(received[0].threadId, 'thread-42');
    assert.equal(received[0].messageId, 'msg-99');
    assert.equal(received[0].channel, 'general');
    assert.equal(received[0].timestamp, 1700000000);

    await transport.disconnect();
  });
});
