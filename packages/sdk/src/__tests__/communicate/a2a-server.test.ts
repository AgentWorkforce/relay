import { describe, it, expect, vi, afterEach } from 'vitest';

import { A2AServer } from '../../communicate/a2a-server.js';
import type { A2AMessage } from '../../communicate/a2a-types.js';

describe('A2AServer', () => {
  let server: A2AServer;

  afterEach(async () => {
    try {
      await server?.stop();
    } catch {
      // ignore
    }
  });

  describe('constructor and getAgentCard', () => {
    it('creates server with defaults', () => {
      server = new A2AServer('test-agent');
      const card = server.getAgentCard();
      expect(card.name).toBe('test-agent');
      expect(card.description).toBe('Agent Relay agent: test-agent');
      expect(card.version).toBe('1.0.0');
      expect(card.capabilities).toEqual({ streaming: true, pushNotifications: false });
      expect(card.skills).toEqual([]);
    });

    it('creates server with custom skills', () => {
      server = new A2AServer('skilled-agent', 0, '127.0.0.1', [
        { id: 's1', name: 'Billing', description: 'Handle billing' },
      ]);
      const card = server.getAgentCard();
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe('s1');
    });
  });

  describe('HTTP endpoints', () => {
    it('serves agent card at /.well-known/agent.json', async () => {
      server = new A2AServer('card-server', 0, '127.0.0.1');
      await server.start();

      const response = await fetch(`${server.url}/.well-known/agent.json`);
      expect(response.ok).toBe(true);

      const card = (await response.json()) as Record<string, unknown>;
      expect(card.name).toBe('card-server');
      expect(card.version).toBe('1.0.0');
      expect(card.url).toBe(server.url);
    });

    it('returns 404 for unknown routes', async () => {
      server = new A2AServer('404-server', 0, '127.0.0.1');
      await server.start();

      const response = await fetch(`${server.url}/unknown`);
      expect(response.status).toBe(404);
    });

    it('returns parse error for invalid JSON', async () => {
      server = new A2AServer('parse-server', 0, '127.0.0.1');
      await server.start();

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{{{',
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe(-32700);
    });

    it('returns method not found for unknown methods', async () => {
      server = new A2AServer('method-server', 0, '127.0.0.1');
      await server.start();

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'unknown/method',
          params: {},
          id: 'rpc-1',
        }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe(-32601);
      expect(error.message).toContain('unknown/method');
    });
  });

  describe('message/send', () => {
    it('handles message/send and creates task', async () => {
      server = new A2AServer('msg-server', 0, '127.0.0.1');
      await server.start();

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ text: 'hello server' }],
              messageId: 'msg-1',
            },
          },
          id: 'rpc-1',
        }),
      });

      expect(response.ok).toBe(true);
      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      expect(result.id).toBeDefined();
      expect((result.status as Record<string, unknown>).state).toBe('completed');
      expect((result.messages as unknown[]).length).toBeGreaterThanOrEqual(1);
    });

    it('invokes onMessage callback and includes response', async () => {
      server = new A2AServer('cb-server', 0, '127.0.0.1');
      await server.start();

      const receivedMessages: A2AMessage[] = [];
      server.onMessage((msg) => {
        receivedMessages.push(msg);
        return {
          role: 'agent',
          parts: [{ text: 'I got your message!' }],
          messageId: 'response-1',
        };
      });

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ text: 'callback test' }],
            },
          },
          id: 'rpc-cb',
        }),
      });

      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;

      // Callback was invoked
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].parts[0].text).toBe('callback test');

      // Response includes agent reply
      const status = result.status as Record<string, unknown>;
      expect(status.state).toBe('completed');
      expect(status.message).toBeDefined();
      const statusMsg = status.message as Record<string, unknown>;
      expect(statusMsg.role).toBe('agent');

      // Messages include both user and agent messages
      const messages = result.messages as Record<string, unknown>[];
      expect(messages.length).toBe(2);
    });

    it('invokes async onMessage callback', async () => {
      server = new A2AServer('async-server', 0, '127.0.0.1');
      await server.start();

      server.onMessage(async (msg) => {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        return {
          role: 'agent',
          parts: [{ text: 'async reply' }],
          messageId: 'async-r1',
        };
      });

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'message/send',
          params: {
            message: { role: 'user', parts: [{ text: 'async test' }] },
          },
          id: 'rpc-async',
        }),
      });

      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      const status = result.status as Record<string, unknown>;
      expect(status.state).toBe('completed');
      expect((status.message as Record<string, unknown>).role).toBe('agent');
    });

    it('reuses existing task when taskId matches', async () => {
      server = new A2AServer('reuse-server', 0, '127.0.0.1');
      await server.start();

      const sendMsg = (taskId: string, text: string) =>
        fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'message/send',
            params: {
              message: { role: 'user', parts: [{ text }], taskId },
            },
            id: `rpc-${text}`,
          }),
        });

      await sendMsg('shared-task', 'first message');
      const response = await sendMsg('shared-task', 'second message');

      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      const messages = result.messages as unknown[];
      expect(messages.length).toBe(2);
    });
  });

  describe('tasks/get', () => {
    it('returns task by ID', async () => {
      server = new A2AServer('get-server', 0, '127.0.0.1');
      await server.start();

      // Create a task first
      await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ text: 'create' }],
              taskId: 'get-task',
            },
          },
          id: 'rpc-create',
        }),
      });

      // Get the task
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tasks/get',
          params: { id: 'get-task' },
          id: 'rpc-get',
        }),
      });

      expect(response.ok).toBe(true);
      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      expect(result.id).toBe('get-task');
    });

    it('returns error for non-existent task', async () => {
      server = new A2AServer('noget-server', 0, '127.0.0.1');
      await server.start();

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tasks/get',
          params: { id: 'nonexistent' },
          id: 'rpc-noget',
        }),
      });

      expect(response.status).toBe(404);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBeDefined();
    });
  });

  describe('tasks/cancel', () => {
    it('cancels a task', async () => {
      server = new A2AServer('cancel-server', 0, '127.0.0.1');
      await server.start();

      // Manually add a working task
      server.tasks.set('cancel-task', {
        id: 'cancel-task',
        contextId: 'ctx-1',
        status: { state: 'working', timestamp: new Date().toISOString() },
        messages: [],
        artifacts: [],
      });

      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tasks/cancel',
          params: { id: 'cancel-task' },
          id: 'rpc-cancel',
        }),
      });

      expect(response.ok).toBe(true);
      const body = (await response.json()) as Record<string, unknown>;
      const result = body.result as Record<string, unknown>;
      expect((result.status as Record<string, unknown>).state).toBe('canceled');
    });
  });

  describe('start / stop', () => {
    it('starts and stops cleanly', async () => {
      server = new A2AServer('lifecycle-server', 0, '127.0.0.1');
      await server.start();

      // Server is running
      const response = await fetch(`${server.url}/.well-known/agent.json`);
      expect(response.ok).toBe(true);

      await server.stop();

      // Server is stopped
      await expect(fetch(`${server.url}/.well-known/agent.json`)).rejects.toThrow();
    });

    it('url updates after start with port 0', async () => {
      server = new A2AServer('port-server', 0, '127.0.0.1');
      await server.start();

      // URL should contain the actual assigned port
      expect(server.url).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
      const port = parseInt(server.url.split(':').pop()!, 10);
      expect(port).toBeGreaterThan(0);
    });
  });
});
