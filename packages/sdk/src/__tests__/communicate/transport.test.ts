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

  /** Override to customize HTTP responses */
  responseOverride?: (method: string, path: string, json?: any) => { status: number; body: unknown } | undefined;

  baseUrl = '';

  constructor() {
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith('/v1/ws/')) {
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

    if (method === 'POST' && path === '/v1/agents/register') {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      const agentId = `agent-${this.nextAgentId++}`;
      sendJson(response, 200, { agent_id: agentId, token: `token-${agentId}` });
      return;
    }

    if (method === 'DELETE' && path.startsWith('/v1/agents/')) {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      response.statusCode = 204;
      response.end();
      return;
    }

    if (method === 'POST' && path === '/v1/messages/dm') {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, { message_id: `msg-${this.nextMessageId++}` });
      return;
    }

    if (method === 'POST' && path === '/v1/messages/channel') {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, { message_id: `msg-${this.nextMessageId++}` });
      return;
    }

    if (method === 'POST' && path === '/v1/messages/reply') {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, { message_id: `msg-${this.nextMessageId++}` });
      return;
    }

    if (method === 'GET' && path.startsWith('/v1/inbox/')) {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, { messages: [] });
      return;
    }

    if (method === 'GET' && path === '/v1/agents') {
      if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
        sendJson(response, 401, { message: 'Unauthorized' });
        return;
      }
      sendJson(response, 200, { agents: ['TestAgent'] });
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

test('registerAgent sends POST /v1/agents/register with auth header', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('TestAgent', server.makeConfig());

    const agentId = await transport.registerAgent();

    assert.ok(agentId.startsWith('agent-'));
    assert.ok(transport.token);
    const req = server.requestsFor('/v1/agents/register')[0];
    assert.equal(req.auth, `Bearer ${server.apiKey}`);
    assert.deepEqual(req.json, { name: 'TestAgent', workspace: server.workspace });
  });
});

test('unregisterAgent sends DELETE /v1/agents/{id}', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('TestAgent', server.makeConfig());

    await transport.registerAgent();
    await transport.unregisterAgent();

    const deleteReqs = server.requestsFor('/v1/agents/agent-');
    assert.ok(deleteReqs.some((r) => r.method === 'DELETE'));
    assert.equal(transport.agentId, undefined);
    assert.equal(transport.token, undefined);
  });
});

test('sendDm sends POST /v1/messages/dm with correct payload', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Sender', server.makeConfig());

    const messageId = await transport.sendDm('Recipient', 'hello');

    assert.ok(messageId.startsWith('msg-'));
    const req = server.requestsFor('/v1/messages/dm')[0];
    assert.deepEqual(req.json, { to: 'Recipient', text: 'hello', from: 'Sender' });
    assert.equal(req.auth, `Bearer ${server.apiKey}`);
  });
});

test('postMessage sends POST /v1/messages/channel', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Poster', server.makeConfig());

    const messageId = await transport.postMessage('general', 'update');

    assert.ok(messageId.startsWith('msg-'));
    const req = server.requestsFor('/v1/messages/channel')[0];
    assert.deepEqual(req.json, { channel: 'general', text: 'update', from: 'Poster' });
  });
});

test('reply sends POST /v1/messages/reply', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Replier', server.makeConfig());

    const messageId = await transport.reply('msg-42', 'response');

    assert.ok(messageId.startsWith('msg-'));
    const req = server.requestsFor('/v1/messages/reply')[0];
    assert.deepEqual(req.json, { message_id: 'msg-42', text: 'response', from: 'Replier' });
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

test('checkInbox sends GET /v1/inbox/{agentId}', async () => {
  await withServer(async (server) => {
    const { RelayTransport } = await loadModules();
    const transport = new RelayTransport('Checker', server.makeConfig());

    const messages = await transport.checkInbox();

    assert.deepEqual(messages, []);
    assert.ok(server.requestsFor('/v1/inbox/').length > 0);
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

    assert.ok(server.requestsFor('/v1/agents/agent-').some((r) => r.method === 'DELETE'));
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
      assert.equal(req.auth, `Bearer ${server.apiKey}`, `Missing auth on ${req.method} ${req.path}`);
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
