import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { WebSocketServer, WebSocket } from 'ws';

const coreModulePath = '../../communicate/core.js';

async function loadCoreModule(): Promise<any> {
  return import(coreModulePath);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error('Timed out waiting for async condition.');
}

function summarizeMessage(message: any) {
  return {
    sender: message.sender,
    text: message.text,
    channel: message.channel,
    threadId: message.threadId,
    messageId: message.messageId,
  };
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

class MockRelayServer {
  readonly apiKey = 'test-key';
  readonly workspace = 'test-workspace';
  readonly inboxes = new Map<string, any[]>();
  readonly registeredAgents = new Map<string, { name: string; token: string }>();

  private readonly extraAgents = new Set<string>();
  private readonly requestLog = new Map<string, Array<{ json?: any }>>();
  private readonly websocketCounts = new Map<string, number>();
  private readonly websockets = new Map<string, WebSocket>();

  private server = createServer(this.handleRequest.bind(this));
  private wsServer = new WebSocketServer({ noServer: true });
  private nextAgentId = 1;
  private nextMessageId = 1;

  baseUrl = '';

  /** Track agent tokens from registration: token -> agentId */
  private tokenToAgentId = new Map<string, string>();

  constructor() {
    this.server.on('upgrade', this.handleUpgrade.bind(this));
    this.wsServer.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const token = url.searchParams.get('token');
      const agentId = token ? this.tokenToAgentId.get(token) : undefined;
      if (!agentId) {
        socket.close();
        return;
      }

      const current = this.websocketCounts.get(agentId) ?? 0;
      this.websocketCounts.set(agentId, current + 1);
      this.websockets.set(agentId, socket);
      socket.on('close', () => {
        if (this.websockets.get(agentId) === socket) {
          this.websockets.delete(agentId);
        }
      });
    });
  }

  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start mock Relaycast server.');
    }
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.websockets.values()) {
      socket.close();
    }
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

  addAgent(name: string): void {
    this.extraAgents.add(name);
  }

  findAgentId(name: string): string | undefined {
    for (const [agentId, registration] of this.registeredAgents.entries()) {
      if (registration.name === name) {
        return agentId;
      }
    }
    return undefined;
  }

  requestCount(operation: string): number {
    return this.requestLog.get(operation)?.length ?? 0;
  }

  lastJson(operation: string): any {
    return this.requestLog.get(operation)?.at(-1)?.json;
  }

  websocketConnectionCountForName(name: string): number {
    const agentId = this.findAgentId(name);
    if (!agentId) return 0;
    return this.websocketCounts.get(agentId) ?? 0;
  }

  websocketConnected(agentId: string): boolean {
    const socket = this.websockets.get(agentId);
    return socket !== undefined && socket.readyState === WebSocket.OPEN;
  }

  async waitForAgentConnection(name: string): Promise<string> {
    let agentId: string | undefined;
    await waitFor(() => {
      agentId = this.findAgentId(name);
      return agentId !== undefined && this.websocketConnected(agentId);
    });
    return agentId!;
  }

  async pushWsMessage(
    agentId: string,
    message: {
      sender: string;
      text: string;
      channel?: string;
      thread_id?: string;
      message_id?: string;
      timestamp?: number;
    }
  ): Promise<void> {
    const socket = this.websockets.get(agentId);
    assert.ok(socket && socket.readyState === WebSocket.OPEN, `No active websocket for ${agentId}`);

    socket.send(
      JSON.stringify({
        type: 'message',
        ...message,
        message_id: message.message_id ?? `message-${this.nextMessageId++}`,
      })
    );
    await sleep(0);
  }

  private record(operation: string, json?: any): void {
    const entries = this.requestLog.get(operation) ?? [];
    entries.push({ json });
    this.requestLog.set(operation, entries);
  }

  private authorizeWorkspaceKey(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
      sendJson(response, 401, { message: 'Unauthorized' });
      return false;
    }
    return true;
  }

  private resolveAgentFromToken(request: IncomingMessage): string | undefined {
    const auth = request.headers.authorization ?? '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7);
      return this.tokenToAgentId.get(token);
    }
    return undefined;
  }

  private authorizeAgentToken(request: IncomingMessage, response: ServerResponse): string | undefined {
    const agentId = this.resolveAgentFromToken(request);
    if (!agentId) {
      sendJson(response, 401, { ok: false, error: { message: 'Unauthorized' } });
    }
    return agentId;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl || 'http://127.0.0.1');
    const pathname = url.pathname;

    // POST /v1/agents — register (workspace key auth)
    if (request.method === 'POST' && pathname === '/v1/agents') {
      const json = await readJson(request);
      this.record('register_agent', json);
      if (!this.authorizeWorkspaceKey(request, response)) return;

      const agentId = `agent-${this.nextAgentId++}`;
      const token = `token-${agentId}`;
      this.registeredAgents.set(agentId, { name: json.name, token });
      this.tokenToAgentId.set(token, agentId);
      sendJson(response, 200, { ok: true, data: { id: agentId, name: json.name, token, status: 'online' } });
      return;
    }

    // POST /v1/agents/disconnect — unregister (agent token auth)
    if (request.method === 'POST' && pathname === '/v1/agents/disconnect') {
      const agentId = this.authorizeAgentToken(request, response);
      if (!agentId) return;
      this.record('unregister_agent', { agent_id: agentId });

      // Remove token mapping
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      this.tokenToAgentId.delete(token);
      this.registeredAgents.delete(agentId);
      this.inboxes.delete(agentId);
      this.websockets.get(agentId)?.close();
      sendJson(response, 200, { ok: true });
      return;
    }

    // POST /v1/dm — send DM (agent token auth)
    if (request.method === 'POST' && pathname === '/v1/dm') {
      const json = await readJson(request);
      const agentId = this.authorizeAgentToken(request, response);
      if (!agentId) return;
      const senderName = this.registeredAgents.get(agentId)?.name ?? 'unknown';
      this.record('send_dm', { ...json, from: senderName });

      const msgId = `message-${this.nextMessageId++}`;
      sendJson(response, 201, { ok: true, data: { id: msgId, text: json.text } });
      return;
    }

    // POST /v1/channels/{channel}/messages — channel post (agent token auth)
    const channelMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/messages$/);
    if (request.method === 'POST' && channelMatch) {
      const json = await readJson(request);
      const channel = decodeURIComponent(channelMatch[1]);
      const agentId = this.authorizeAgentToken(request, response);
      if (!agentId) return;
      const senderName = this.registeredAgents.get(agentId)?.name ?? 'unknown';
      this.record('post_message', { ...json, channel, from: senderName });

      const msgId = `message-${this.nextMessageId++}`;
      sendJson(response, 201, { ok: true, data: { id: msgId, channel_name: channel, text: json.text } });
      return;
    }

    // POST /v1/messages/{id}/replies — reply (agent token auth)
    const replyMatch = pathname.match(/^\/v1\/messages\/([^/]+)\/replies$/);
    if (request.method === 'POST' && replyMatch) {
      const json = await readJson(request);
      const parentId = decodeURIComponent(replyMatch[1]);
      const agentId = this.authorizeAgentToken(request, response);
      if (!agentId) return;
      const senderName = this.registeredAgents.get(agentId)?.name ?? 'unknown';
      this.record('reply', { ...json, message_id: parentId, from: senderName });

      const msgId = `message-${this.nextMessageId++}`;
      sendJson(response, 201, { ok: true, data: { id: msgId, text: json.text } });
      return;
    }

    // GET /v1/inbox — inbox (agent token auth)
    if (request.method === 'GET' && pathname === '/v1/inbox') {
      const agentId = this.authorizeAgentToken(request, response);
      if (!agentId) return;
      this.record('check_inbox', { agent_id: agentId });

      const messages = this.inboxes.get(agentId) ?? [];
      this.inboxes.set(agentId, []);
      sendJson(response, 200, { ok: true, data: { unread_channels: [], mentions: [], unread_dms: messages, recent_reactions: [] } });
      return;
    }

    // GET /v1/agents — list agents (workspace key auth)
    if (request.method === 'GET' && pathname === '/v1/agents') {
      this.record('list_agents');
      if (!this.authorizeWorkspaceKey(request, response)) return;

      const agentList: Array<{ name: string; id: string; status: string }> = [];
      for (const [agentId, registration] of this.registeredAgents.entries()) {
        agentList.push({ name: registration.name, id: agentId, status: 'online' });
      }
      for (const name of this.extraAgents) {
        agentList.push({ name, id: `extra-${name}`, status: 'online' });
      }
      sendJson(response, 200, { ok: true, data: agentList });
      return;
    }

    sendJson(response, 404, { message: 'Not found' });
  }

  private handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    const url = new URL(request.url ?? '/', this.baseUrl || 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname !== '/v1/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.destroy();
      return;
    }
    const agentId = this.tokenToAgentId.get(token);
    if (!agentId || !this.registeredAgents.has(agentId)) {
      socket.destroy();
      return;
    }

    this.wsServer.handleUpgrade(request, socket, head, (ws) => {
      this.wsServer.emit('connection', ws, request);
    });
  }
}

async function withServer(run: (server: MockRelayServer) => Promise<void>): Promise<void> {
  const server = new MockRelayServer();
  await server.start();
  try {
    await run(server);
  } finally {
    await server.stop();
  }
}

async function waitForInbox(relay: any, timeoutMs = 1_000): Promise<any[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const messages = await relay.inbox();
    if (messages.length > 0) {
      return messages;
    }
    await sleep(10);
  }
  throw new Error('Timed out waiting for inbox messages.');
}

test('Relay lazily connects on first send and delegates DMs', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const relay = new Relay('CoreTester', server.makeConfig());

    assert.equal(server.requestCount('register_agent'), 0);
    assert.equal(server.websocketConnectionCountForName('CoreTester'), 0);

    try {
      const result = await relay.send('Impl-Core', 'hello');

      assert.equal(result, undefined);
      assert.equal(server.requestCount('register_agent'), 1);
      await waitFor(() => server.websocketConnectionCountForName('CoreTester') === 1);
      assert.deepEqual(server.lastJson('send_dm'), {
        to: 'Impl-Core',
        text: 'hello',
        from: 'CoreTester',
      });
    } finally {
      await relay.close();
    }
  });
});

test('Relay delegates channel posts', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const relay = new Relay('CorePoster', server.makeConfig());

    try {
      const result = await relay.post('ts-track', 'status update');

      assert.equal(result, undefined);
      assert.deepEqual(server.lastJson('post_message'), {
        channel: 'ts-track',
        text: 'status update',
        from: 'CorePoster',
      });
    } finally {
      await relay.close();
    }
  });
});

test('Relay delegates thread replies', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const relay = new Relay('CoreReplier', server.makeConfig());

    try {
      const result = await relay.reply('message-123', 'thread response');

      assert.equal(result, undefined);
      assert.deepEqual(server.lastJson('reply'), {
        message_id: 'message-123',
        text: 'thread response',
        from: 'CoreReplier',
      });
    } finally {
      await relay.close();
    }
  });
});

test('Relay inbox drains buffered websocket messages and clears the buffer', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const relay = new Relay('CoreInbox', server.makeConfig());

    try {
      await relay.agents();
      const agentId = await server.waitForAgentConnection('CoreInbox');

      await server.pushWsMessage(agentId, {
        sender: 'Review-Core',
        text: 'one',
        message_id: 'message-1',
      });
      await server.pushWsMessage(agentId, {
        sender: 'Impl-Core',
        text: 'two',
        channel: 'ts-track',
        thread_id: 'thread-1',
        message_id: 'message-2',
      });

      const first = await waitForInbox(relay);
      const second = await relay.inbox();

      assert.deepEqual(first.map(summarizeMessage), [
        {
          sender: 'Review-Core',
          text: 'one',
          channel: undefined,
          threadId: undefined,
          messageId: 'message-1',
        },
        {
          sender: 'Impl-Core',
          text: 'two',
          channel: 'ts-track',
          threadId: 'thread-1',
          messageId: 'message-2',
        },
      ]);
      assert.deepEqual(second, []);
      assert.equal(server.requestCount('check_inbox'), 0);
    } finally {
      await relay.close();
    }
  });
});

test('Relay onMessage callbacks receive live messages and unsubscribe restores buffering', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const relay = new Relay('CoreCallback', server.makeConfig());
    const received: any[] = [];

    try {
      const unsubscribe = relay.onMessage((message: any) => {
        received.push(message);
      });

      const agentId = await server.waitForAgentConnection('CoreCallback');
      await server.pushWsMessage(agentId, {
        sender: 'Lead',
        text: 'callback',
        message_id: 'message-callback',
      });
      await waitFor(() => received.length === 1);

      unsubscribe();

      await server.pushWsMessage(agentId, {
        sender: 'Impl-Core',
        text: 'buffered',
        message_id: 'message-buffered',
      });

      const inboxMessages = await waitForInbox(relay);

      assert.deepEqual(received.map(summarizeMessage), [
        {
          sender: 'Lead',
          text: 'callback',
          channel: undefined,
          threadId: undefined,
          messageId: 'message-callback',
        },
      ]);
      assert.deepEqual(inboxMessages.map(summarizeMessage), [
        {
          sender: 'Impl-Core',
          text: 'buffered',
          channel: undefined,
          threadId: undefined,
          messageId: 'message-buffered',
        },
      ]);
    } finally {
      await relay.close();
    }
  });
});

test('Relay agents() returns online agent names', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    server.addAgent('Review-Core');
    server.addAgent('Impl-Core');
    const relay = new Relay('CoreRoster', server.makeConfig());

    try {
      const agents = await relay.agents();

      assert.deepEqual([...agents].sort(), ['CoreRoster', 'Impl-Core', 'Review-Core']);
      assert.equal(server.requestCount('list_agents'), 1);
    } finally {
      await relay.close();
    }
  });
});

test('Relay close() unregisters the agent and closes the websocket', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const relay = new Relay('CoreCloser', server.makeConfig());

    await relay.send('Impl-Core', 'hello');
    const agentId = await server.waitForAgentConnection('CoreCloser');
    assert.ok(server.registeredAgents.has(agentId));

    await relay.close();

    assert.equal(server.requestCount('unregister_agent'), 1);
    assert.equal(server.registeredAgents.has(agentId), false);
    assert.equal(server.websocketConnected(agentId), false);
  });
});
