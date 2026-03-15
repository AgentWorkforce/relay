/**
 * A2A (Agent-to-Agent) protocol transport implementation.
 *
 * Client side: sends JSON-RPC 2.0 to external A2A agent endpoints.
 * Server side: runs a local HTTP server accepting A2A JSON-RPC calls.
 */

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';

import type { Message, MessageCallback } from './types.js';
import {
  type A2AAgentCard,
  type A2AConfig,
  type A2AMessage,
  type A2ATask,
  type A2ATaskStatus,
  type JsonRpcResponse,
  A2A_TASK_NOT_CANCELABLE,
  A2A_TASK_NOT_FOUND,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  a2aAgentCardFromDict,
  a2aAgentCardToDict,
  a2aMessageFromDict,
  a2aMessageGetText,
  a2aMessageToDict,
  a2aTaskToDict,
  createA2AAgentCard,
  createA2ATaskStatus,
  makeJsonRpcError,
  makeJsonRpcRequest,
  makeJsonRpcResponse,
} from './a2a-types.js';

export class A2AError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(`A2A error ${code}: ${message}`);
    this.name = 'A2AError';
    this.code = code;
  }
}

export class A2ATransport {
  readonly config: A2AConfig;

  agentName?: string;
  agentCard?: A2AAgentCard;
  tasks: Map<string, A2ATask> = new Map();

  private _messageCallbacks: MessageCallback[] = [];
  private _server?: http.Server;
  private _discoveredCards: Map<string, A2AAgentCard> = new Map();
  private _closing = false;

  constructor(config: A2AConfig) {
    this.config = config;
  }

  // === Transport interface ===

  async register(name: string): Promise<{ name: string; url: string; type: string }> {
    this.agentName = name;
    const host = this.config.serverHost ?? '0.0.0.0';
    const port = this.config.serverPort ?? 5000;

    this.agentCard = createA2AAgentCard(
      name,
      this.config.agentDescription ?? `Agent Relay agent: ${name}`,
      `http://${host}:{PORT}`,
      this.config.skills ?? [],
    );

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this._handleRequest(req, res);
      });

      server.on('error', reject);

      server.listen(port, host, () => {
        this._server = server;
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        this.agentCard!.url = `http://${host}:${actualPort}`;
        resolve({ name, url: this.agentCard!.url, type: 'a2a' });
      });
    });
  }

  async unregister(): Promise<void> {
    this._closing = true;
    if (this._server) {
      await new Promise<void>((resolve, reject) => {
        this._server!.close((err) => (err ? reject(err) : resolve()));
      });
      this._server = undefined;
    }
    this._closing = false;
  }

  async sendDm(target: string, text: string): Promise<Record<string, unknown>> {
    const card = await this._discoverAgent(target);

    const message: A2AMessage = {
      role: 'user',
      parts: [{ text }],
      messageId: randomUUID(),
    };

    const rpcRequest = makeJsonRpcRequest('message/send', {
      message: a2aMessageToDict(message),
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._authHeaders(),
    };

    const response = await fetch(card.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpcRequest),
    });

    const body = (await response.json()) as JsonRpcResponse;

    if (body.error) {
      throw new A2AError(body.error.code, body.error.message);
    }

    const result = (body.result ?? {}) as Record<string, unknown>;
    return this._a2aResultToRelay(result, card.name);
  }

  async listAgents(): Promise<Record<string, unknown>[]> {
    const agents: Record<string, unknown>[] = [];
    for (const url of this.config.registry ?? []) {
      try {
        const card = await this._discoverAgent(url);
        agents.push({
          name: card.name,
          url: card.url,
          description: card.description,
          skills: card.skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
        });
      } catch {
        continue;
      }
    }
    return agents;
  }

  onMessage(callback: MessageCallback): void {
    this._messageCallbacks.push(callback);
  }

  async connectWs(): Promise<void> {
    // A2A uses HTTP, not WebSocket. No-op.
  }

  // === HTTP request handler ===

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
      await this._handleAgentCard(res);
      return;
    }

    if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
      await this._handleJsonRpcHttp(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async _handleAgentCard(res: http.ServerResponse): Promise<void> {
    if (!this.agentCard) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not registered' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(a2aAgentCardToDict(this.agentCard)));
  }

  private async _handleJsonRpcHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const raw = await this._readBody(req);
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      const error = makeJsonRpcError(JSONRPC_PARSE_ERROR, 'Parse error', null);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error));
      return;
    }

    const result = await this._dispatchJsonRpc(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }

  private _readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });
  }

  // === JSON-RPC dispatch ===

  private async _dispatchJsonRpc(request: Record<string, unknown>): Promise<JsonRpcResponse> {
    const rpcId = (request.id ?? null) as string | number | null;
    const method = (request.method ?? '') as string;
    const params = (request.params ?? {}) as Record<string, unknown>;

    const handlers: Record<string, (p: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
      'message/send': (p) => this._handleMessageSend(p),
      'tasks/get': (p) => this._handleTasksGet(p),
      'tasks/cancel': (p) => this._handleTasksCancel(p),
    };

    const handler = handlers[method];
    if (!handler) {
      return makeJsonRpcError(JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`, rpcId);
    }

    try {
      const result = await handler(params);
      return makeJsonRpcResponse(result, rpcId as string | number);
    } catch (err) {
      if (err instanceof A2AError) {
        return makeJsonRpcError(err.code, err.message, rpcId);
      }
      return makeJsonRpcError(JSONRPC_INTERNAL_ERROR, String(err), rpcId);
    }
  }

  private async _handleMessageSend(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const msgData = params.message as Record<string, unknown> | undefined;
    if (!msgData) {
      throw new A2AError(JSONRPC_INVALID_PARAMS, "Missing 'message' in params");
    }

    const a2aMsg = a2aMessageFromDict(msgData);
    const taskId = a2aMsg.taskId ?? randomUUID();
    const contextId = a2aMsg.contextId ?? randomUUID();

    let task: A2ATask;
    if (this.tasks.has(taskId)) {
      task = this.tasks.get(taskId)!;
      task.messages.push(a2aMsg);
      task.status = createA2ATaskStatus('working');
    } else {
      task = {
        id: taskId,
        contextId,
        status: createA2ATaskStatus('working'),
        messages: [a2aMsg],
        artifacts: [],
      };
      this.tasks.set(taskId, task);
    }

    // Convert to Relay message and invoke callbacks
    const relayMsg = A2ATransport._a2aToRelayMsg(a2aMsg, 'a2a-client');
    await this._invokeCallbacks(relayMsg);

    // Mark completed
    task.status = createA2ATaskStatus('completed');

    return a2aTaskToDict(task);
  }

  private async _handleTasksGet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = (params.id as string) ?? '';
    if (!taskId || !this.tasks.has(taskId)) {
      throw new A2AError(A2A_TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }
    return a2aTaskToDict(this.tasks.get(taskId)!);
  }

  private async _handleTasksCancel(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const taskId = (params.id as string) ?? '';
    if (!taskId || !this.tasks.has(taskId)) {
      throw new A2AError(A2A_TASK_NOT_FOUND, `Task not found: ${taskId}`);
    }

    const task = this.tasks.get(taskId)!;
    if (['completed', 'failed', 'canceled'].includes(task.status.state)) {
      throw new A2AError(
        A2A_TASK_NOT_CANCELABLE,
        `Task ${taskId} is already ${task.status.state}`,
      );
    }

    task.status = createA2ATaskStatus('canceled');
    return a2aTaskToDict(task);
  }

  // === Agent discovery ===

  private async _discoverAgent(url: string): Promise<A2AAgentCard> {
    const normalizedUrl = url.replace(/\/+$/, '');

    if (this._discoveredCards.has(normalizedUrl)) {
      return this._discoveredCards.get(normalizedUrl)!;
    }

    const cardUrl = `${normalizedUrl}/.well-known/agent.json`;
    const response = await fetch(cardUrl);

    if (!response.ok) {
      throw new A2AError(-1, `Failed to discover agent at ${cardUrl}: HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown>;
    const card = a2aAgentCardFromDict(data);
    this._discoveredCards.set(normalizedUrl, card);
    return card;
  }

  // === Message conversion ===

  static _relayMsgToA2A(text: string, _sender: string): A2AMessage {
    return {
      role: 'user',
      parts: [{ text }],
      messageId: randomUUID(),
    };
  }

  static _a2aToRelayMsg(msg: A2AMessage, sender: string = 'unknown'): Message {
    const text = a2aMessageGetText(msg);
    return {
      sender,
      text,
      channel: undefined,
      threadId: msg.contextId,
      messageId: msg.messageId,
    };
  }

  private _a2aResultToRelay(result: Record<string, unknown>, sender: string): Record<string, unknown> {
    const messages = (result.messages as Record<string, unknown>[] | undefined) ?? [];
    let text = '';
    if (messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      const parts = (lastMsg.parts as Record<string, unknown>[] | undefined) ?? [];
      text = parts
        .filter((p) => p.text)
        .map((p) => p.text as string)
        .join(' ');
    }

    return {
      sender,
      text,
      task_id: result.id,
      status: (result.status as Record<string, unknown> | undefined)?.state,
    };
  }

  // === Internal helpers ===

  private async _invokeCallbacks(msg: Message): Promise<void> {
    for (const cb of this._messageCallbacks) {
      await cb(msg);
    }
  }

  private _authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.authToken) {
      if (this.config.authScheme === 'api_key') {
        headers['X-API-Key'] = this.config.authToken;
      } else {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }
    }
    return headers;
  }
}
