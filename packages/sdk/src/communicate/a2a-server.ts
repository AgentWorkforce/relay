/**
 * A2A-compliant HTTP server that exposes a Relay agent as an A2A endpoint.
 *
 * Routes:
 *   GET  /.well-known/agent.json  -> Agent Card
 *   POST /                        -> JSON-RPC 2.0 dispatcher
 */

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';

import {
  type A2AAgentCard,
  type A2AMessage,
  type A2APart,
  type A2ASkill,
  type A2ATask,
  type A2ATaskStatus,
  a2aAgentCardToDict,
  a2aMessageToDict,
  createA2AAgentCard,
  createA2ATaskStatus,
} from './a2a-types.js';

export type A2AMessageHandler = (
  msg: A2AMessage,
) => A2AMessage | null | Promise<A2AMessage | null>;

export class A2AServer {
  readonly agentName: string;
  readonly port: number;
  readonly host: string;
  readonly skills: A2ASkill[];
  readonly tasks: Map<string, A2ATask> = new Map();

  private _onMessage?: A2AMessageHandler;
  private _server?: http.Server;
  private _actualPort?: number;

  constructor(
    agentName: string,
    port: number = 5000,
    host: string = '0.0.0.0',
    skills: A2ASkill[] = [],
  ) {
    this.agentName = agentName;
    this.port = port;
    this.host = host;
    this.skills = skills;
  }

  get url(): string {
    const p = this._actualPort ?? this.port;
    return `http://${this.host}:${p}`;
  }

  onMessage(callback: A2AMessageHandler): void {
    this._onMessage = callback;
  }

  getAgentCard(): A2AAgentCard {
    return createA2AAgentCard(
      this.agentName,
      `Agent Relay agent: ${this.agentName}`,
      this.url,
      [...this.skills],
    );
  }

  async handleMessageSend(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const messageData = (params.message ?? {}) as Record<string, unknown>;
    const rawParts = (messageData.parts ?? []) as Record<string, unknown>[];
    const parts: A2APart[] = rawParts.map((p) => ({ text: p.text as string | undefined }));

    const incoming: A2AMessage = {
      role: (messageData.role as 'user' | 'agent') ?? 'user',
      parts,
      messageId: (messageData.messageId as string) ?? randomUUID(),
      contextId: messageData.contextId as string | undefined,
      taskId: messageData.taskId as string | undefined,
    };

    // Create or find task
    const taskId = incoming.taskId ?? randomUUID();
    const contextId = incoming.contextId ?? randomUUID();

    let task: A2ATask;
    if (this.tasks.has(taskId)) {
      task = this.tasks.get(taskId)!;
      task.messages.push(incoming);
      task.status = createA2ATaskStatus('working');
    } else {
      task = {
        id: taskId,
        contextId,
        status: createA2ATaskStatus('working'),
        messages: [incoming],
        artifacts: [],
      };
      this.tasks.set(taskId, task);
    }

    // Invoke callback
    let responseMsg: A2AMessage | null = null;
    if (this._onMessage) {
      const result = this._onMessage(incoming);
      responseMsg = result instanceof Promise ? await result : result;
    }

    if (responseMsg) {
      task.messages.push(responseMsg);
      task.status = createA2ATaskStatus('completed', responseMsg);
    } else {
      task.status = createA2ATaskStatus('completed');
    }

    return taskToDict(task);
  }

  async handleTasksGet(taskId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return taskToDict(task);
  }

  async handleTasksCancel(taskId: string): Promise<Record<string, unknown>> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.status = createA2ATaskStatus('canceled');
    return taskToDict(task);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this._handleRequest(req, res);
      });

      server.on('error', reject);

      server.listen(this.port, this.host, () => {
        this._server = server;
        const addr = server.address();
        if (typeof addr === 'object' && addr) {
          this._actualPort = addr.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this._server) {
      await new Promise<void>((resolve, reject) => {
        this._server!.close((err) => (err ? reject(err) : resolve()));
      });
      this._server = undefined;
      this._actualPort = undefined;
    }
  }

  // --- HTTP handlers ---

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
      const card = this.getAgentCard();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(a2aAgentCardToDict(card)));
      return;
    }

    if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
      await this._handleJsonRpc(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async _handleJsonRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        }),
      );
      return;
    }

    const method = (body.method ?? '') as string;
    const params = (body.params ?? {}) as Record<string, unknown>;
    const rpcId = body.id ?? null;

    try {
      let result: Record<string, unknown>;

      if (method === 'message/send') {
        result = await this.handleMessageSend(params);
      } else if (method === 'tasks/get') {
        const id = (params.id ?? params.taskId ?? '') as string;
        result = await this.handleTasksGet(id);
      } else if (method === 'tasks/cancel') {
        const id = (params.id ?? params.taskId ?? '') as string;
        result = await this.handleTasksCancel(id);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${method}` },
            id: rpcId,
          }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result, id: rpcId }));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32602, message: String(err) },
          id: rpcId,
        }),
      );
    }
  }
}

// --- Helpers ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function taskToDict(task: A2ATask): Record<string, unknown> {
  const statusDict: Record<string, unknown> = { state: task.status.state };
  if (task.status.message) {
    statusDict.message = a2aMessageToDict(task.status.message);
  }

  const messages = task.messages.map((m) => {
    const md: Record<string, unknown> = {
      role: m.role,
      parts: m.parts.map((p) => ({ text: p.text })),
    };
    if (m.messageId) md.messageId = m.messageId;
    return md;
  });

  return {
    id: task.id,
    contextId: task.contextId,
    status: statusDict,
    messages,
    artifacts: task.artifacts,
  };
}
