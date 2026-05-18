import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'vitest';

import { WebSocketServer, WebSocket } from 'ws';

const coreModulePath = '../../../communicate/core.js';
const piAdapterModulePath = '../../../communicate/adapters/pi.js';
const claudeAdapterModulePath = '../../../communicate/adapters/claude-sdk.js';

async function loadCoreModule(): Promise<any> {
  return import(coreModulePath);
}

async function loadPiAdapterModule(): Promise<any> {
  return import(piAdapterModulePath);
}

async function loadClaudeAdapterModule(): Promise<any> {
  return import(claudeAdapterModulePath);
}

async function waitFor<T>(run: () => Promise<T | undefined>, timeoutMs = 1_000): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T | undefined;

  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await run();
    if (lastValue !== undefined) {
      return lastValue;
    }
    await sleep(10);
  }

  throw new Error(`Timed out waiting for async condition. Last value: ${String(lastValue)}`);
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

  private server = createServer(this.handleRequest.bind(this));
  private wsServer = new WebSocketServer({ noServer: true });
  private nextAgentId = 1;
  private nextMessageId = 1;
  private readonly websockets = new Map<string, WebSocket>();

  baseUrl = '';

  constructor() {
    this.server.on('upgrade', this.handleUpgrade.bind(this));
    this.wsServer.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const agentId = url.pathname.split('/').at(-1);
      if (!agentId) {
        socket.close();
        return;
      }

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

  findAgentId(name: string): string | undefined {
    for (const [agentId, registration] of this.registeredAgents.entries()) {
      if (registration.name === name) {
        return agentId;
      }
    }
    return undefined;
  }

  async waitForAgent(name: string): Promise<string> {
    return waitFor(async () => {
      const agentId = this.findAgentId(name);
      return agentId;
    });
  }

  private queueInboxByName(name: string, payload: any): void {
    const agentId = this.findAgentId(name);
    if (!agentId) {
      return;
    }

    const current = this.inboxes.get(agentId) ?? [];
    current.push(payload);
    this.inboxes.set(agentId, current);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.baseUrl || 'http://127.0.0.1');
    const pathname = url.pathname;

    if (request.headers.authorization !== `Bearer ${this.apiKey}`) {
      sendJson(response, 401, { message: 'Unauthorized' });
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/agents/register') {
      const json = await readJson(request);
      const agentId = `agent-${this.nextAgentId++}`;
      const token = `token-${agentId}`;
      this.registeredAgents.set(agentId, { name: json.name, token });
      sendJson(response, 200, { agent_id: agentId, token });
      return;
    }

    if (request.method === 'DELETE' && pathname.startsWith('/v1/agents/')) {
      const agentId = pathname.split('/').at(-1)!;
      this.registeredAgents.delete(agentId);
      this.inboxes.delete(agentId);
      this.websockets.get(agentId)?.close();
      sendJson(response, 204, {});
      return;
    }

    if (request.method === 'POST' && pathname === '/v1/messages/dm') {
      const json = await readJson(request);
      const messageId = `message-${this.nextMessageId++}`;
      // Queue in HTTP inbox
      this.queueInboxByName(json.to, {
        sender: json.from,
        text: json.text,
        message_id: messageId,
      });
      // Also push via WebSocket to recipient (real server does this)
      const recipientAgentId = this.findAgentId(json.to);
      if (recipientAgentId) {
        const ws = this.websockets.get(recipientAgentId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'message',
              sender: json.from,
              text: json.text,
              message_id: messageId,
            })
          );
        }
      }
      sendJson(response, 200, { message_id: messageId });
      return;
    }

    if (request.method === 'GET' && pathname.startsWith('/v1/inbox/')) {
      const agentId = pathname.split('/').at(-1)!;
      const messages = this.inboxes.get(agentId) ?? [];
      this.inboxes.set(agentId, []);
      sendJson(response, 200, { messages });
      return;
    }

    if (request.method === 'GET' && pathname === '/v1/agents') {
      sendJson(response, 200, { agents: [...this.registeredAgents.values()].map((entry) => entry.name) });
      return;
    }

    sendJson(response, 404, { message: 'Not found' });
  }

  private handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    const url = new URL(request.url ?? '/', this.baseUrl || 'http://127.0.0.1');
    const pathname = url.pathname;
    if (!pathname.startsWith('/v1/ws/')) {
      socket.destroy();
      return;
    }

    const agentId = pathname.split('/').at(-1)!;
    const token = url.searchParams.get('token');
    const registration = this.registeredAgents.get(agentId);
    if (!registration || token !== registration.token) {
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

function getPiTool(config: any, name: string) {
  const tool = config.customTools?.find((candidate: any) => candidate.name === name);
  assert.ok(tool, `Expected Pi tool ${name} to be registered`);
  return tool;
}

function getClaudePostToolUseHook(options: any) {
  const matcher = options.hooks?.PostToolUse?.at(-1);
  assert.ok(matcher, 'Expected a Claude PostToolUse matcher');
  assert.ok(Array.isArray(matcher.hooks), 'Expected PostToolUse matcher to include hooks');
  return matcher.hooks[0];
}

async function invokeClaudePostToolUse(hook: any): Promise<any> {
  return hook(
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: {},
      tool_response: {},
      tool_use_id: 'tool-1',
    },
    'tool-1',
    { signal: new AbortController().signal }
  );
}

async function waitForClaudeSystemMessage(hook: any, expected: string[]): Promise<string> {
  return waitFor(async () => {
    const result = await invokeClaudePostToolUse(hook);
    const systemMessage = result?.systemMessage;
    if (typeof systemMessage === 'string' && expected.every((fragment) => systemMessage.includes(fragment))) {
      return systemMessage;
    }
    return undefined;
  });
}

async function waitForPiInbox(tool: any, expected: string[]): Promise<string> {
  return waitFor(async () => {
    const result = await tool.execute('tool-2', {});
    const content = result.content.map((entry: any) => entry.text).join('\n');
    if (expected.every((fragment) => content.includes(fragment))) {
      return content;
    }
    return undefined;
  });
}

test('Pi relay_send reaches Claude PostToolUse hook over the shared relay server', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const { onRelay: onPi } = await loadPiAdapterModule();
    const { onRelay: onClaude } = await loadClaudeAdapterModule();

    const piRelay = new Relay('PiSender', server.makeConfig());
    const claudeRelay = new Relay('ClaudeReceiver', server.makeConfig());

    const piConfig = onPi('PiSender', {}, piRelay);
    const claudeOptions = onClaude('ClaudeReceiver', {}, claudeRelay);
    const sendTool = getPiTool(piConfig, 'relay_send');
    const postToolUseHook = getClaudePostToolUseHook(claudeOptions);

    try {
      await invokeClaudePostToolUse(postToolUseHook);
      await server.waitForAgent('ClaudeReceiver');

      await sendTool.execute('tool-1', {
        to: 'ClaudeReceiver',
        text: 'ping from Pi',
      });

      const systemMessage = await waitForClaudeSystemMessage(postToolUseHook, [
        'Relay message from PiSender: ping from Pi',
      ]);
      assert.match(systemMessage, /Relay message from PiSender: ping from Pi/);
    } finally {
      await Promise.all([piRelay.close(), claudeRelay.close()]);
    }
  });
});

test('Claude relay send is visible through the Pi relay_inbox tool over the shared relay server', async () => {
  await withServer(async (server) => {
    const { Relay } = await loadCoreModule();
    const { onRelay: onPi } = await loadPiAdapterModule();
    const { onRelay: onClaude } = await loadClaudeAdapterModule();

    const piRelay = new Relay('PiReceiver', server.makeConfig());
    const claudeRelay = new Relay('ClaudeSender', server.makeConfig());

    const piConfig = onPi('PiReceiver', {}, piRelay);
    onClaude('ClaudeSender', {}, claudeRelay);
    const inboxTool = getPiTool(piConfig, 'relay_inbox');

    try {
      await inboxTool.execute('tool-0', {});
      await server.waitForAgent('PiReceiver');

      await claudeRelay.send('PiReceiver', 'reply from Claude');

      const inboxText = await waitForPiInbox(inboxTool, [
        'Relay message from ClaudeSender: reply from Claude',
      ]);
      assert.match(inboxText, /Relay message from ClaudeSender: reply from Claude/);
    } finally {
      await Promise.all([piRelay.close(), claudeRelay.close()]);
    }
  });
});
