/**
 * Integration tests for MultiProjectClient
 * Tests actual socket connections with a real daemon
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Daemon } from '../daemon/server.js';
import { RelayClient } from '../wrapper/client.js';
import { MultiProjectClient } from './multi-project-client.js';
import type { ProjectConfig } from './types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Test fixtures
const TEST_DIR = path.join(os.tmpdir(), 'agent-relay-integration-test');
const PROJECT_A_DIR = path.join(TEST_DIR, 'project-a');
const PROJECT_B_DIR = path.join(TEST_DIR, 'project-b');

function createTestDirs(): void {
  fs.mkdirSync(path.join(PROJECT_A_DIR, 'team'), { recursive: true });
  fs.mkdirSync(path.join(PROJECT_B_DIR, 'team'), { recursive: true });
}

function cleanupTestDirs(): void {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('MultiProjectClient Integration', () => {
  let daemonA: Daemon;
  let daemonB: Daemon;
  let socketPathA: string;
  let socketPathB: string;

  beforeAll(async () => {
    cleanupTestDirs();
    createTestDirs();

    socketPathA = path.join(PROJECT_A_DIR, 'relay.sock');
    socketPathB = path.join(PROJECT_B_DIR, 'relay.sock');

    // Start two daemons
    daemonA = new Daemon({
      socketPath: socketPathA,
      pidFilePath: path.join(PROJECT_A_DIR, 'relay.pid'),
      storagePath: path.join(PROJECT_A_DIR, 'messages.sqlite'),
      teamDir: path.join(PROJECT_A_DIR, 'team'),
    });

    daemonB = new Daemon({
      socketPath: socketPathB,
      pidFilePath: path.join(PROJECT_B_DIR, 'relay.pid'),
      storagePath: path.join(PROJECT_B_DIR, 'messages.sqlite'),
      teamDir: path.join(PROJECT_B_DIR, 'team'),
    });

    await daemonA.start();
    await daemonB.start();
  }, 10000);

  afterAll(async () => {
    await daemonA?.stop();
    await daemonB?.stop();
    cleanupTestDirs();
  });

  describe('connection management', () => {
    it('connects to multiple project daemons', async () => {
      const projects: ProjectConfig[] = [
        {
          path: PROJECT_A_DIR,
          id: 'project-a',
          socketPath: socketPathA,
          leadName: 'Alice',
          cli: 'claude',
        },
        {
          path: PROJECT_B_DIR,
          id: 'project-b',
          socketPath: socketPathB,
          leadName: 'Bob',
          cli: 'claude',
        },
      ];

      const client = new MultiProjectClient(projects);

      await client.connect();

      const connected = client.getConnectedProjects();
      expect(connected).toContain('project-a');
      expect(connected).toContain('project-b');

      client.disconnect();
    });

    it('handles missing daemon gracefully', async () => {
      const projects: ProjectConfig[] = [
        {
          path: PROJECT_A_DIR,
          id: 'project-a',
          socketPath: socketPathA,
          leadName: 'Alice',
          cli: 'claude',
        },
        {
          path: '/nonexistent',
          id: 'missing',
          socketPath: '/nonexistent/relay.sock',
          leadName: 'Missing',
          cli: 'claude',
        },
      ];

      const client = new MultiProjectClient(projects);

      // Should throw because one project is missing
      await expect(client.connect()).rejects.toThrow();

      client.disconnect();
    });
  });

  describe('message routing', () => {
    let bridgeClient: MultiProjectClient;
    let agentAlice: RelayClient;
    let agentBob: RelayClient;

    beforeEach(async () => {
      // Set up bridge client
      const projects: ProjectConfig[] = [
        {
          path: PROJECT_A_DIR,
          id: 'project-a',
          socketPath: socketPathA,
          leadName: 'Alice',
          cli: 'claude',
        },
        {
          path: PROJECT_B_DIR,
          id: 'project-b',
          socketPath: socketPathB,
          leadName: 'Bob',
          cli: 'claude',
        },
      ];

      bridgeClient = new MultiProjectClient(projects);
      await bridgeClient.connect();

      // Set up agents in each project
      agentAlice = new RelayClient({
        agentName: 'Alice',
        socketPath: socketPathA,
        reconnect: false,
      });

      agentBob = new RelayClient({
        agentName: 'Bob',
        socketPath: socketPathB,
        reconnect: false,
      });

      await agentAlice.connect();
      await agentBob.connect();
    });

    afterEach(() => {
      agentAlice?.disconnect();
      agentBob?.disconnect();
      bridgeClient?.disconnect();
    });

    it('sends message to specific project agent', async () => {
      const receivedMessages: string[] = [];

      agentAlice.onMessage = (from, payload) => {
        receivedMessages.push(`${from}: ${payload.body}`);
      };

      // Bridge sends to Alice in project-a
      const sent = bridgeClient.sendToProject('project-a', 'Alice', 'Hello Alice!');
      expect(sent).toBe(true);

      // Wait for message delivery
      await new Promise(r => setTimeout(r, 100));

      expect(receivedMessages).toContain('__BridgeClient: Hello Alice!');
    });

    it('sends message to lead by alias', async () => {
      const receivedMessages: string[] = [];

      agentAlice.onMessage = (from, payload) => {
        receivedMessages.push(payload.body);
      };

      // Register Alice as lead for project-a
      bridgeClient.registerLead('project-a', 'Alice');

      // Send to 'lead' - should resolve to Alice
      bridgeClient.sendToProject('project-a', 'lead', 'Hello Lead!');

      await new Promise(r => setTimeout(r, 100));

      expect(receivedMessages).toContain('Hello Lead!');
    });

    it('broadcasts to all leads', async () => {
      const messagesAlice: string[] = [];
      const messagesBob: string[] = [];

      agentAlice.onMessage = (from, payload) => {
        messagesAlice.push(payload.body);
      };

      agentBob.onMessage = (from, payload) => {
        messagesBob.push(payload.body);
      };

      // Register leads
      bridgeClient.registerLead('project-a', 'Alice');
      bridgeClient.registerLead('project-b', 'Bob');

      // Broadcast to all leads
      bridgeClient.broadcastToLeads('Standup time!');

      await new Promise(r => setTimeout(r, 100));

      expect(messagesAlice).toContain('Standup time!');
      expect(messagesBob).toContain('Standup time!');
    });
  });
});
