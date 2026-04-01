import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';

import { A2ATransport, A2AError } from '../../communicate/a2a-transport.js';
import type { A2AConfig } from '../../communicate/a2a-types.js';

/** Start a minimal A2A mock server and return its URL + cleanup fn. */
function startMockA2AServer(
  agentCard: Record<string, unknown>,
  onJsonRpc?: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/.well-known/agent.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(agentCard));
        return;
      }

      if (req.method === 'POST' && req.url === '/') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
          const response = onJsonRpc?.(body) ?? {
            jsonrpc: '2.0',
            result: {
              id: 'task-1',
              status: { state: 'completed' },
              messages: [
                { role: 'agent', parts: [{ text: 'mock reply' }] },
              ],
              artifacts: [],
            },
            id: body.id,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

describe('A2ATransport', () => {
  let transport: A2ATransport;

  afterEach(async () => {
    try {
      await transport?.unregister();
    } catch {
      // ignore
    }
  });

  describe('register / unregister', () => {
    it('starts HTTP server and returns agent info', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);

      const info = await transport.register('test-agent');
      expect(info.name).toBe('test-agent');
      expect(info.type).toBe('a2a');
      expect(info.url).toContain('http://');
      expect(transport.agentCard).toBeDefined();
      expect(transport.agentCard!.name).toBe('test-agent');
    });

    it('serves agent card at /.well-known/agent.json', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);
      const info = await transport.register('card-agent');

      const response = await fetch(`${info.url}/.well-known/agent.json`);
      expect(response.ok).toBe(true);
      const card = (await response.json()) as Record<string, unknown>;
      expect(card.name).toBe('card-agent');
      expect(card.version).toBe('1.0.0');
    });

    it('unregisters and stops server', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);
      const info = await transport.register('stop-agent');

      await transport.unregister();

      await expect(fetch(`${info.url}/.well-known/agent.json`)).rejects.toThrow();
    });
  });

  describe('JSON-RPC dispatch', () => {
    it('handles message/send and invokes callbacks', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);
      const info = await transport.register('dispatch-agent');

      const received: string[] = [];
      transport.onMessage((msg) => {
        received.push(msg.text);
      });

      const rpcRequest = {
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ text: 'hello from test' }],
            messageId: 'msg-1',
          },
        },
        id: 'rpc-1',
      };

      const response = await fetch(info.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rpcRequest),
      });

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe('rpc-1');

      const result = body.result as Record<string, unknown>;
      expect(result.id).toBeDefined();
      expect((result.status as Record<string, unknown>).state).toBe('completed');

      expect(received).toEqual(['hello from test']);
    });

    it('handles tasks/get', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);
      const info = await transport.register('tasks-agent');

      // First create a task via message/send
      const sendReq = {
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ text: 'create task' }],
            taskId: 'my-task',
          },
        },
        id: 'rpc-send',
      };

      await fetch(info.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendReq),
      });

      // Now get the task
      const getReq = {
        jsonrpc: '2.0',
        method: 'tasks/get',
        params: { id: 'my-task' },
        id: 'rpc-get',
      };

      const response = await fetch(info.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getReq),
      });

      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      expect(result.id).toBe('my-task');
      expect((result.status as Record<string, unknown>).state).toBe('completed');
    });

    it('handles tasks/cancel', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);
      const info = await transport.register('cancel-agent');

      // Create a task and manually set it to working
      transport.tasks.set('cancel-me', {
        id: 'cancel-me',
        contextId: 'ctx-1',
        status: { state: 'working', timestamp: new Date().toISOString() },
        messages: [],
        artifacts: [],
      });

      const cancelReq = {
        jsonrpc: '2.0',
        method: 'tasks/cancel',
        params: { id: 'cancel-me' },
        id: 'rpc-cancel',
      };

      const response = await fetch(info.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cancelReq),
      });

      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      expect((result.status as Record<string, unknown>).state).toBe('canceled');
    });

    it('returns method not found for unknown methods', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);
      const info = await transport.register('unknown-method-agent');

      const req = {
        jsonrpc: '2.0',
        method: 'unknown/method',
        params: {},
        id: 'rpc-unk',
      };

      const response = await fetch(info.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
      expect((body.error as Record<string, unknown>).code).toBe(-32601);
    });

    it('returns parse error for invalid JSON', async () => {
      const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
      transport = new A2ATransport(config);
      const info = await transport.register('parse-err-agent');

      const response = await fetch(info.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json{{{',
      });

      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
      expect((body.error as Record<string, unknown>).code).toBe(-32700);
    });
  });

  describe('sendDm (client side)', () => {
    it('sends message/send to external A2A agent', async () => {
      const mockCard = {
        name: 'mock-agent',
        description: 'Mock A2A agent',
        url: '', // will be set after server starts
        version: '1.0.0',
        capabilities: { streaming: false },
        skills: [],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
      };

      let receivedMethod: string | undefined;
      const mock = await startMockA2AServer(mockCard, (body) => {
        receivedMethod = body.method as string;
        return {
          jsonrpc: '2.0',
          result: {
            id: 'task-99',
            status: { state: 'completed' },
            messages: [
              { role: 'user', parts: [{ text: 'hello' }] },
              { role: 'agent', parts: [{ text: 'reply from mock' }] },
            ],
            artifacts: [],
          },
          id: body.id,
        };
      });

      // Update mock card URL
      mockCard.url = mock.url;

      try {
        const config: A2AConfig = { serverHost: '127.0.0.1', serverPort: 0 };
        transport = new A2ATransport(config);

        const result = await transport.sendDm(mock.url, 'hello external agent');
        expect(receivedMethod).toBe('message/send');
        expect(result.sender).toBe('mock-agent');
        expect(result.text).toBe('reply from mock');
        expect(result.task_id).toBe('task-99');
        expect(result.status).toBe('completed');
      } finally {
        await mock.close();
      }
    });

    it('throws A2AError on error response', async () => {
      const mockCard = {
        name: 'err-agent',
        description: 'Error agent',
        url: '',
        version: '1.0.0',
        capabilities: {},
        skills: [],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
      };

      const mock = await startMockA2AServer(mockCard, (body) => ({
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Bad params' },
        id: body.id,
      }));

      mockCard.url = mock.url;

      try {
        const config: A2AConfig = {};
        transport = new A2ATransport(config);

        await expect(transport.sendDm(mock.url, 'bad')).rejects.toThrow(A2AError);
      } finally {
        await mock.close();
      }
    });

    it('caches discovered agent cards', async () => {
      let discoveryCount = 0;
      const mockCard = {
        name: 'cache-agent',
        description: 'Cache test',
        url: '',
        version: '1.0.0',
        capabilities: {},
        skills: [],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
      };

      const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const srv = http.createServer((req, res) => {
          if (req.url === '/.well-known/agent.json') {
            discoveryCount++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mockCard));
            return;
          }
          if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                result: { id: 't', status: { state: 'completed' }, messages: [], artifacts: [] },
                id: body.id,
              }));
            });
            return;
          }
          res.writeHead(404);
          res.end();
        });

        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as { port: number };
          const url = `http://127.0.0.1:${addr.port}`;
          mockCard.url = url;
          resolve({
            url,
            close: () => new Promise<void>((r, j) => srv.close((e) => (e ? j(e) : r()))),
          });
        });
      });

      try {
        const config: A2AConfig = {};
        transport = new A2ATransport(config);

        await transport.sendDm(server.url, 'first');
        await transport.sendDm(server.url, 'second');

        expect(discoveryCount).toBe(1); // Only discovered once
      } finally {
        await server.close();
      }
    });
  });

  describe('listAgents', () => {
    it('lists agents from registry', async () => {
      const mockCard = {
        name: 'reg-agent',
        description: 'Registry agent',
        url: 'http://localhost:9999',
        version: '1.0.0',
        capabilities: {},
        skills: [{ id: 's1', name: 'Skill', description: 'A skill' }],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
      };

      const mock = await startMockA2AServer(mockCard);

      try {
        const config: A2AConfig = { registry: [mock.url] };
        transport = new A2ATransport(config);

        const agents = await transport.listAgents();
        expect(agents).toHaveLength(1);
        expect(agents[0].name).toBe('reg-agent');
        expect(agents[0].description).toBe('Registry agent');
      } finally {
        await mock.close();
      }
    });

    it('skips unreachable agents', async () => {
      const config: A2AConfig = { registry: ['http://127.0.0.1:19999'] };
      transport = new A2ATransport(config);

      const agents = await transport.listAgents();
      expect(agents).toEqual([]);
    });
  });

  describe('connectWs', () => {
    it('is a no-op', async () => {
      transport = new A2ATransport({});
      await expect(transport.connectWs()).resolves.toBeUndefined();
    });
  });

  describe('message conversion', () => {
    it('converts relay message to A2A', () => {
      const msg = A2ATransport._relayMsgToA2A('hello', 'sender-1');
      expect(msg.role).toBe('user');
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0].text).toBe('hello');
    });

    it('converts A2A message to relay', () => {
      const a2aMsg = {
        role: 'agent' as const,
        parts: [{ text: 'response' }],
        messageId: 'mid-1',
        contextId: 'ctx-1',
      };
      const relayMsg = A2ATransport._a2aToRelayMsg(a2aMsg, 'sender');
      expect(relayMsg.sender).toBe('sender');
      expect(relayMsg.text).toBe('response');
      expect(relayMsg.threadId).toBe('ctx-1');
      expect(relayMsg.messageId).toBe('mid-1');
    });
  });

  describe('auth headers', () => {
    it('includes bearer token', async () => {
      let receivedAuth: string | undefined;
      const mockCard = {
        name: 'auth-agent',
        description: 'Auth test',
        url: '',
        version: '1.0.0',
        capabilities: {},
        skills: [],
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
      };

      const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const srv = http.createServer((req, res) => {
          if (req.url === '/.well-known/agent.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(mockCard));
            return;
          }
          if (req.method === 'POST') {
            receivedAuth = req.headers.authorization;
            const chunks: Buffer[] = [];
            req.on('data', (c: Buffer) => chunks.push(c));
            req.on('end', () => {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                result: { id: 't', status: { state: 'completed' }, messages: [], artifacts: [] },
                id: body.id,
              }));
            });
            return;
          }
          res.writeHead(404);
          res.end();
        });

        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address() as { port: number };
          const url = `http://127.0.0.1:${addr.port}`;
          mockCard.url = url;
          resolve({
            url,
            close: () => new Promise<void>((r, j) => srv.close((e) => (e ? j(e) : r()))),
          });
        });
      });

      try {
        const config: A2AConfig = {
          authScheme: 'bearer',
          authToken: 'test-token-123',
        };
        transport = new A2ATransport(config);

        await transport.sendDm(server.url, 'auth test');
        expect(receivedAuth).toBe('Bearer test-token-123');
      } finally {
        await server.close();
      }
    });
  });
});
