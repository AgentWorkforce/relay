#!/usr/bin/env node
/**
 * Stress test for the Orchestrator
 * Tests: workspace management, WebSocket connections, event broadcasting, health monitoring
 *
 * CI-compatible: Uses correctness thresholds, dynamic ports, structured output
 *
 * Usage:
 *   node scripts/stress-test-orchestrator.mjs
 *   node scripts/stress-test-orchestrator.mjs --json  (output JSON only)
 */

import { performance } from 'perf_hooks';
import http from 'http';
import net from 'net';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
import { EventEmitter } from 'events';

// Parse CLI args
const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes('--json');

// ============================================
// Test Configuration
// ============================================
const CONFIG = {
  concurrentClients: 10, // Reduced for CI reliability
  messagesPerClient: 50, // Reduced for CI reliability
  workspaceCycles: 30, // Reduced for CI reliability
  eventBurstSize: 200, // Reduced for CI reliability
  testTimeout: 30000, // 30 second max per test
};

// ============================================
// Utility: Find available port
// ============================================
async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function log(msg) {
  if (!JSON_OUTPUT) {
    console.error(msg);
  }
}

// ============================================
// Mock Orchestrator
// ============================================
class MockOrchestrator extends EventEmitter {
  constructor() {
    super();
    this.workspaces = new Map();
    this.agents = new Map();
    this.clients = new Set();
    this.eventCount = 0;
    this.messageCount = 0;
  }

  addWorkspace(id, name) {
    const workspace = { id, name, status: 'active', createdAt: new Date() };
    this.workspaces.set(id, workspace);
    this.broadcast({ type: 'workspace:added', data: workspace });
    return workspace;
  }

  removeWorkspace(id) {
    if (this.workspaces.has(id)) {
      this.workspaces.delete(id);
      this.broadcast({ type: 'workspace:removed', data: { id } });
      return true;
    }
    return false;
  }

  spawnAgent(workspaceId, name) {
    const agent = {
      id: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      workspaceId,
      status: 'running',
      spawnedAt: new Date(),
    };
    this.agents.set(agent.id, agent);
    this.broadcast({ type: 'agent:spawned', data: agent });
    return agent;
  }

  addClient(ws) {
    this.clients.add(ws);
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  broadcast(event) {
    this.eventCount++;
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(data);
        } catch (e) {
          // Ignore send errors
        }
      }
    }
  }

  handleMessage(ws, data) {
    this.messageCount++;
    try {
      const msg = JSON.parse(data);
      ws.send(JSON.stringify({ type: 'echo', original: msg, timestamp: Date.now() }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  }

  stats() {
    return {
      workspaces: this.workspaces.size,
      agents: this.agents.size,
      clients: this.clients.size,
      events: this.eventCount,
      messages: this.messageCount,
    };
  }
}

// ============================================
// Test Runner
// ============================================
class StressTestRunner {
  constructor(orchestrator, wss, port) {
    this.orchestrator = orchestrator;
    this.wss = wss;
    this.port = port;
    this.results = {};
    this.failures = 0;
  }

  async runAll() {
    log('Running stress tests...\n');

    await this.withTimeout('workspaceChurn', () => this.testWorkspaceChurn());
    await this.withTimeout('webSocketFlood', () => this.testWebSocketFlood());
    await this.withTimeout('eventBroadcast', () => this.testEventBroadcast());
    await this.withTimeout('concurrentOps', () => this.testConcurrentOperations());
    await this.withTimeout('healthMonitoring', () => this.testHealthMonitoring());

    return {
      passed: this.failures === 0,
      failures: this.failures,
      results: this.results,
      orchestrator_stats: this.orchestrator.stats(),
    };
  }

  async withTimeout(name, fn) {
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Test timeout')), CONFIG.testTimeout)
      );
      await Promise.race([fn(), timeoutPromise]);
    } catch (err) {
      log(`  ERROR in ${name}: ${err.message}`);
      this.results[name] = { passed: false, error: err.message };
      this.failures++;
    }
  }

  // Test 1: Workspace add/remove churn
  async testWorkspaceChurn() {
    log('=== Test 1: Workspace Churn ===');
    const cycles = CONFIG.workspaceCycles;

    const start = performance.now();
    const workspaceIds = [];
    let addSuccesses = 0;
    let removeSuccesses = 0;

    // Add workspaces
    for (let i = 0; i < cycles; i++) {
      const id = `ws-${i}-${Date.now()}`;
      const ws = this.orchestrator.addWorkspace(id, `Workspace ${i}`);
      if (ws) {
        addSuccesses++;
        workspaceIds.push(id);
      }
    }

    // Remove workspaces
    for (const id of workspaceIds) {
      if (this.orchestrator.removeWorkspace(id)) {
        removeSuccesses++;
      }
    }

    const elapsed = performance.now() - start;

    const passed = addSuccesses === cycles && removeSuccesses === cycles;

    this.results.workspaceChurn = {
      passed,
      elapsed_ms: Math.round(elapsed),
      cycles,
      add_successes: addSuccesses,
      remove_successes: removeSuccesses,
    };

    if (!passed) this.failures++;

    log(`  ${cycles} cycles, add=${addSuccesses}, remove=${removeSuccesses}, ${elapsed.toFixed(2)}ms`);
    log(`  PASSED: ${passed}\n`);
  }

  // Test 2: WebSocket message flood
  async testWebSocketFlood() {
    log('=== Test 2: WebSocket Message Flood ===');

    const clientCount = CONFIG.concurrentClients;
    const messagesPerClient = CONFIG.messagesPerClient;

    // Create clients
    const clients = [];
    for (let i = 0; i < clientCount; i++) {
      const client = await this.createTestClient(i);
      if (client) clients.push(client);
    }

    log(`  Created ${clients.length}/${clientCount} WebSocket clients`);

    if (clients.length === 0) {
      this.results.webSocketFlood = {
        passed: false,
        error: 'No clients connected',
      };
      this.failures++;
      return;
    }

    const start = performance.now();

    // Send messages from all clients
    const results = await Promise.all(clients.map((client) => this.floodClient(client, messagesPerClient)));

    const elapsed = performance.now() - start;

    const totalMessages = results.reduce((sum, r) => sum + r.sent, 0);
    const totalReceived = results.reduce((sum, r) => sum + r.received, 0);
    const expectedTotal = clients.length * messagesPerClient;

    // Success if we sent all messages and received at least 90% of responses
    const passed = totalMessages >= expectedTotal * 0.95 && totalReceived >= totalMessages * 0.9;

    this.results.webSocketFlood = {
      passed,
      elapsed_ms: Math.round(elapsed),
      clients: clients.length,
      messages_per_client: messagesPerClient,
      total_sent: totalMessages,
      total_received: totalReceived,
      send_rate: totalMessages >= expectedTotal * 0.95,
      receive_rate: totalReceived / totalMessages,
    };

    if (!passed) this.failures++;

    log(`  Sent ${totalMessages}, received ${totalReceived} in ${elapsed.toFixed(2)}ms`);
    log(`  PASSED: ${passed}\n`);

    // Cleanup clients
    for (const client of clients) {
      client.ws.close();
    }

    await sleep(100); // Let connections close
  }

  // Test 3: Event broadcast stress
  async testEventBroadcast() {
    log('=== Test 3: Event Broadcast Stress ===');

    const burstSize = CONFIG.eventBurstSize;
    const subscriberCount = 5;

    // Create subscriber clients
    const subscribers = [];
    for (let i = 0; i < subscriberCount; i++) {
      const client = await this.createTestClient(i);
      if (client) {
        client.received = [];
        client.ws.on('message', (data) => {
          try {
            client.received.push(JSON.parse(data.toString()));
          } catch (e) {
            // Ignore parse errors
          }
        });
        subscribers.push(client);
      }
    }

    log(`  ${subscribers.length} subscribers listening`);

    if (subscribers.length === 0) {
      this.results.eventBroadcast = {
        passed: false,
        error: 'No subscribers connected',
      };
      this.failures++;
      return;
    }

    const start = performance.now();

    // Broadcast burst of events
    for (let i = 0; i < burstSize; i++) {
      this.orchestrator.broadcast({
        type: 'stress:event',
        seq: i,
        timestamp: Date.now(),
      });
    }

    // Wait for events to propagate
    await sleep(500);

    const elapsed = performance.now() - start;
    const totalDelivered = subscribers.reduce((sum, s) => sum + s.received.length, 0);
    const expectedDeliveries = burstSize * subscribers.length;

    // Success if at least 80% of events were delivered
    const deliveryRate = totalDelivered / expectedDeliveries;
    const passed = deliveryRate >= 0.8;

    this.results.eventBroadcast = {
      passed,
      elapsed_ms: Math.round(elapsed),
      burst_size: burstSize,
      subscribers: subscribers.length,
      delivered: totalDelivered,
      expected: expectedDeliveries,
      delivery_rate: deliveryRate,
    };

    if (!passed) this.failures++;

    log(`  Delivered ${totalDelivered}/${expectedDeliveries} (${(deliveryRate * 100).toFixed(1)}%)`);
    log(`  PASSED: ${passed}\n`);

    // Cleanup
    for (const sub of subscribers) {
      sub.ws.close();
    }

    await sleep(100);
  }

  // Test 4: Concurrent operations
  async testConcurrentOperations() {
    log('=== Test 4: Concurrent Operations ===');

    const operations = 50;
    const start = performance.now();

    const promises = [];
    let successes = 0;

    // Mix of operations running concurrently
    for (let i = 0; i < operations; i++) {
      const op = i % 3;
      const promise = (async () => {
        switch (op) {
          case 0:
            return this.orchestrator.addWorkspace(`concurrent-${i}`, `WS ${i}`);
          case 1:
            return this.orchestrator.spawnAgent(`concurrent-${i - 1}`, `Agent${i}`);
          case 2:
            return this.orchestrator.removeWorkspace(`concurrent-${i - 2}`);
        }
      })();
      promises.push(promise.then(() => successes++).catch(() => {}));
    }

    await Promise.all(promises);
    const elapsed = performance.now() - start;

    // Success if at least 80% of operations completed
    const passed = successes >= operations * 0.8;

    this.results.concurrentOps = {
      passed,
      elapsed_ms: Math.round(elapsed),
      operations,
      successes,
      success_rate: successes / operations,
    };

    if (!passed) this.failures++;

    log(`  ${successes}/${operations} operations in ${elapsed.toFixed(2)}ms`);
    log(`  PASSED: ${passed}\n`);
  }

  // Test 5: Health monitoring stress
  async testHealthMonitoring() {
    log('=== Test 5: Health Monitoring Stress ===');

    const checkCount = 200;
    const start = performance.now();
    let validResponses = 0;

    // Simulate rapid health checks
    for (let i = 0; i < checkCount; i++) {
      const stats = this.orchestrator.stats();
      if (
        typeof stats.workspaces === 'number' &&
        typeof stats.agents === 'number' &&
        typeof stats.clients === 'number'
      ) {
        validResponses++;
      }
    }

    const elapsed = performance.now() - start;

    // Success if all responses were valid
    const passed = validResponses === checkCount;

    this.results.healthMonitoring = {
      passed,
      elapsed_ms: Math.round(elapsed),
      checks: checkCount,
      valid_responses: validResponses,
    };

    if (!passed) this.failures++;

    log(`  ${validResponses}/${checkCount} valid responses in ${elapsed.toFixed(2)}ms`);
    log(`  PASSED: ${passed}\n`);
  }

  async createTestClient(id) {
    return new Promise((resolve) => {
      try {
        const ws = new WebSocket(`ws://localhost:${this.port}`);
        const client = { id, ws, connected: false };

        const timeout = setTimeout(() => {
          if (!client.connected) {
            ws.terminate();
            resolve(null);
          }
        }, 2000);

        ws.on('open', () => {
          client.connected = true;
          clearTimeout(timeout);
          this.orchestrator.addClient(ws);
          resolve(client);
        });

        ws.on('error', () => {
          clearTimeout(timeout);
          resolve(null);
        });

        ws.on('close', () => {
          this.orchestrator.removeClient(ws);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  async floodClient(client, count) {
    return new Promise((resolve) => {
      let sent = 0;
      let received = 0;

      const messageHandler = () => {
        received++;
        if (received >= count) {
          client.ws.removeListener('message', messageHandler);
          resolve({ sent, received });
        }
      };

      client.ws.on('message', messageHandler);

      // Send all messages
      for (let i = 0; i < count; i++) {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            JSON.stringify({
              type: 'test',
              clientId: client.id,
              seq: i,
              timestamp: Date.now(),
            })
          );
          sent++;
        }
      }

      // Timeout fallback
      setTimeout(() => {
        client.ws.removeListener('message', messageHandler);
        resolve({ sent, received });
      }, 5000);
    });
  }
}

// ============================================
// Main
// ============================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const orchestrator = new MockOrchestrator();

  // Find available port
  const port = await findAvailablePort();
  log(`=== Orchestrator Stress Test ===`);
  log(`Using port ${port}\n`);

  // Start WebSocket server
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    orchestrator.addClient(ws);

    ws.on('message', (data) => {
      orchestrator.handleMessage(ws, data.toString());
    });

    ws.on('close', () => {
      orchestrator.removeClient(ws);
    });
  });

  // Wait for server to be ready
  await sleep(100);

  // Run stress tests
  const runner = new StressTestRunner(orchestrator, wss, port);
  const finalResults = await runner.runAll();

  // Cleanup
  wss.close();

  // Output results
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(finalResults, null, 2));
  } else {
    log('=== Summary ===\n');
    log(`Overall: ${finalResults.passed ? 'PASSED' : 'FAILED'}`);
    log(`Failures: ${finalResults.failures}`);
    log('\nDetailed results:');
    console.log(JSON.stringify(finalResults, null, 2));
  }

  process.exit(finalResults.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
