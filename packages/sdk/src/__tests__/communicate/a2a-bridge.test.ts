import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import http from 'node:http';

import { A2ABridge } from '../../communicate/a2a-bridge.js';
import { A2AServer } from '../../communicate/a2a-server.js';
import type { RelayConfig } from '../../communicate/types.js';

const mockRelayConfig: RelayConfig = {
  workspace: 'test-workspace',
  apiKey: 'rk_test_key',
  baseUrl: 'https://api.test.dev',
};

describe('A2ABridge', () => {
  describe('construction', () => {
    it('creates bridge with correct properties', () => {
      const bridge = new A2ABridge(
        mockRelayConfig,
        'http://localhost:9999',
        'proxy-agent',
      );
      expect(bridge.proxyName).toBe('proxy-agent');
      expect(bridge.a2aAgentUrl).toBe('http://localhost:9999');
    });

    it('strips trailing slashes from URL', () => {
      const bridge = new A2ABridge(
        mockRelayConfig,
        'http://localhost:9999///',
        'proxy-agent',
      );
      expect(bridge.a2aAgentUrl).toBe('http://localhost:9999');
    });
  });

  describe('discoverAgent', () => {
    let mockServer: http.Server;
    let port: number;

    beforeEach(async () => {
      mockServer = http.createServer((req, res) => {
        if (req.url === '/.well-known/agent.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              name: 'test-a2a-agent',
              description: 'A test agent',
              url: `http://localhost:${port}`,
              version: '1.0.0',
              capabilities: { streaming: false, pushNotifications: false },
              skills: [{ id: 'billing', name: 'Billing', description: 'Handles billing' }],
              defaultInputModes: ['text'],
              defaultOutputModes: ['text'],
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => {
        mockServer.listen(0, () => {
          const addr = mockServer.address();
          port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('discovers agent card from well-known URL', async () => {
      const bridge = new A2ABridge(
        mockRelayConfig,
        `http://localhost:${port}`,
        'proxy',
      );
      const card = await bridge.discoverAgent();
      expect(card.name).toBe('test-a2a-agent');
      expect(card.description).toBe('A test agent');
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe('billing');
    });
  });

  describe('sendA2AMessage', () => {
    let mockServer: http.Server;
    let port: number;

    beforeEach(async () => {
      mockServer = http.createServer((req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            const request = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  id: 'task-001',
                  status: {
                    state: 'completed',
                    message: {
                      role: 'agent',
                      parts: [{ text: 'I processed your billing request' }],
                    },
                  },
                  messages: [],
                },
              }),
            );
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((resolve) => {
        mockServer.listen(0, () => {
          const addr = mockServer.address();
          port = typeof addr === 'object' && addr ? addr.port : 0;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    });

    it('sends A2A message and gets response', async () => {
      const bridge = new A2ABridge(
        mockRelayConfig,
        `http://localhost:${port}`,
        'proxy',
      );
      const response = await bridge.sendA2AMessage('Process refund for order #1042');
      expect(response).toBe('I processed your billing request');
    });

    it('returns null when no response text', async () => {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
      mockServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          const request = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { id: 'task-002', status: { state: 'completed' }, messages: [] },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => {
        mockServer.listen(port, () => resolve());
      });

      const bridge = new A2ABridge(
        mockRelayConfig,
        `http://localhost:${port}`,
        'proxy',
      );
      const response = await bridge.sendA2AMessage('hello');
      expect(response).toBeNull();
    });
  });

  describe('integration with A2AServer', () => {
    let a2aServer: A2AServer;
    let serverPort: number;

    beforeEach(async () => {
      a2aServer = new A2AServer('billing-specialist', 0, [
        { id: 'billing', name: 'Billing', description: 'Handles billing queries' },
      ]);
      a2aServer.onMessage(async (msg) => {
        const text = msg.parts.find((p) => p.text)?.text ?? '';
        return {
          role: 'agent' as const,
          parts: [{ text: `Processed: ${text}` }],
        };
      });
      serverPort = await a2aServer.start();
    });

    afterEach(async () => {
      await a2aServer.stop();
    });

    it('bridge discovers and communicates with A2AServer', async () => {
      const bridge = new A2ABridge(
        mockRelayConfig,
        `http://localhost:${serverPort}`,
        'billing-proxy',
      );

      const card = await bridge.discoverAgent();
      expect(card.name).toBe('billing-specialist');

      const response = await bridge.sendA2AMessage('Refund order #1042');
      expect(response).toBe('Processed: Refund order #1042');
    });
  });
});
