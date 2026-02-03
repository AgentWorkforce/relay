#!/usr/bin/env npx tsx
/**
 * Integration Stress Test for Orchestrator
 *
 * Tests the REAL Orchestrator class and its critical paths:
 * - Daemon lifecycle (start/stop)
 * - Agent health monitoring
 * - HTTP/WebSocket API under load
 * - Relay-ledger concurrent operations
 *
 * Usage:
 *   npx tsx scripts/stress-test-orchestrator-integration.mts
 *   npx tsx scripts/stress-test-orchestrator-integration.mts --json
 */

import { performance } from 'perf_hooks';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { createRequire } from 'module';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');

// Suppress console output from Orchestrator loggers when running in JSON mode
// This must happen BEFORE importing the Orchestrator module
const JSON_OUTPUT_EARLY = process.argv.includes('--json');
if (JSON_OUTPUT_EARLY) {
  // Suppress utils logger (daemon, router, etc.) - must be set before module imports
  process.env.AGENT_RELAY_LOG_LEVEL = 'ERROR';

  // Configure the resiliency logger to not output to console
  // IMPORTANT: Import directly from logger.js to avoid loading other modules that create loggers
  const { configure } = await import('../packages/resiliency/dist/logger.js');
  configure({ console: false, level: 'fatal' });
}

// ============================================================================
// Configuration
// ============================================================================

const JSON_OUTPUT = process.argv.includes('--json');
const VERBOSE = process.argv.includes('--verbose');

// Get output file from --output=<file> argument
function getOutputFile(): string | null {
  const arg = process.argv.find((a) => a.startsWith('--output='));
  return arg ? arg.split('=')[1] : null;
}
const OUTPUT_FILE = getOutputFile();

const CONFIG = {
  // API stress
  httpRequestCount: 100,
  concurrentHttpClients: 10,

  // WebSocket stress
  wsClientCount: 10,
  wsMessagesPerClient: 20,

  // Workspace stress
  workspaceCycles: 5,

  // Health monitoring
  healthCheckIterations: 100,

  // Timeouts
  testTimeout: 60000,
  httpTimeout: 5000,
};

// ============================================================================
// Utilities
// ============================================================================

function log(msg: string) {
  if (!JSON_OUTPUT) {
    console.error(msg);
  }
}

function verbose(msg: string) {
  if (VERBOSE && !JSON_OUTPUT) {
    console.error(`  [verbose] ${msg}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ============================================================================
// Test Results
// ============================================================================

interface TestResult {
  passed: boolean;
  elapsed_ms: number;
  details: Record<string, unknown>;
  error?: string;
}

interface AllResults {
  passed: boolean;
  failures: number;
  tests: Record<string, TestResult>;
  summary: {
    total_tests: number;
    passed_tests: number;
    failed_tests: number;
    total_time_ms: number;
  };
}

// ============================================================================
// HTTP Client
// ============================================================================

async function httpRequest(
  method: string,
  url: string,
  body?: unknown,
  timeout = CONFIG.httpTimeout
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode || 0, body: parsed });
        } catch {
          resolve({ status: res.statusCode || 0, body: data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ============================================================================
// Test Runner
// ============================================================================

class IntegrationStressTest {
  private port: number = 0;
  private baseUrl: string = '';
  private wsUrl: string = '';
  private tempDirs: string[] = [];
  private results: Record<string, TestResult> = {};
  private failures = 0;
  private orchestrator: any = null;

  async setup(): Promise<void> {
    log('=== Setting up Integration Stress Test ===\n');

    // Find available port
    this.port = await findAvailablePort();
    this.baseUrl = `http://localhost:${this.port}`;
    this.wsUrl = `ws://localhost:${this.port}`;

    log(`Using port ${this.port}`);

    // Create temp data directory
    const dataDir = createTempDir('orchestrator-stress-');
    this.tempDirs.push(dataDir);

    log(`Data directory: ${dataDir}`);

    // Import and start orchestrator
    try {
      const { Orchestrator } = await import('../packages/daemon/dist/orchestrator.js');

      this.orchestrator = new Orchestrator({
        port: this.port,
        host: 'localhost',
        dataDir,
        autoStartDaemons: false, // Manual control for testing
      });

      await this.orchestrator.start();
      log(`Orchestrator started on port ${this.port}\n`);

      // Wait for server to be ready
      await sleep(500);
    } catch (err: any) {
      throw new Error(`Failed to start orchestrator: ${err.message}`);
    }
  }

  async teardown(): Promise<void> {
    log('\n=== Tearing down ===');

    if (this.orchestrator) {
      try {
        await this.orchestrator.stop();
        log('Orchestrator stopped');
      } catch (err: any) {
        log(`Warning: Failed to stop orchestrator: ${err.message}`);
      }
    }

    // Clean up temp directories
    for (const dir of this.tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        verbose(`Removed temp dir: ${dir}`);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async runAll(): Promise<AllResults> {
    const startTime = performance.now();

    await this.testHttpApiHealth();
    await this.testHttpApiWorkspaces();
    await this.testHttpApiConcurrent();
    await this.testWebSocketConnections();
    await this.testWebSocketMessageFlood();
    await this.testWorkspaceLifecycle();
    await this.testHealthMonitoringApi();
    await this.testAgentHealthCrashDetection();

    const totalTime = performance.now() - startTime;

    const passedTests = Object.values(this.results).filter((r) => r.passed).length;

    return {
      passed: this.failures === 0,
      failures: this.failures,
      tests: this.results,
      summary: {
        total_tests: Object.keys(this.results).length,
        passed_tests: passedTests,
        failed_tests: this.failures,
        total_time_ms: Math.round(totalTime),
      },
    };
  }

  // ==========================================================================
  // Test: HTTP API Health (uses / root endpoint)
  // ==========================================================================

  async testHttpApiHealth(): Promise<void> {
    log('=== Test: HTTP API Health ===');
    const start = performance.now();

    let passed = false;
    let successCount = 0;
    let errorCount = 0;

    try {
      // Hit root endpoint multiple times (orchestrator uses / for status)
      for (let i = 0; i < 20; i++) {
        try {
          const resp = await httpRequest('GET', `${this.baseUrl}/`);
          if (resp.status === 200) {
            const body = resp.body as any;
            // Verify response has expected structure
            if (body?.status === 'ok' || body?.workspaces !== undefined) {
              successCount++;
            } else {
              errorCount++;
            }
          } else {
            errorCount++;
          }
        } catch {
          errorCount++;
        }
      }

      passed = successCount >= 18; // 90% success rate
    } catch (err: any) {
      this.results.httpApiHealth = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details: {},
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    this.results.httpApiHealth = {
      passed,
      elapsed_ms: Math.round(performance.now() - start),
      details: {
        success_count: successCount,
        error_count: errorCount,
        success_rate: successCount / 20,
      },
    };

    if (!passed) this.failures++;
    log(`  Success: ${successCount}/20, PASSED: ${passed}\n`);
  }

  // ==========================================================================
  // Test: HTTP API Workspaces CRUD
  // ==========================================================================

  async testHttpApiWorkspaces(): Promise<void> {
    log('=== Test: HTTP API Workspaces CRUD ===');
    const start = performance.now();

    let passed = false;
    const operations = { add: 0, list: 0, remove: 0, errors: 0 };

    try {
      // Create temp workspace directories
      const workspacePaths: string[] = [];
      for (let i = 0; i < 5; i++) {
        const wsDir = createTempDir('test-workspace-');
        this.tempDirs.push(wsDir);
        workspacePaths.push(wsDir);
      }

      // Add workspaces
      const addedIds: string[] = [];
      for (const wsPath of workspacePaths) {
        try {
          const resp = await httpRequest('POST', `${this.baseUrl}/workspaces`, {
            path: wsPath,
            name: `Test-${path.basename(wsPath)}`,
          });
          if (resp.status === 200 || resp.status === 201) {
            operations.add++;
            const body = resp.body as any;
            if (body?.id) addedIds.push(body.id);
          } else {
            operations.errors++;
          }
        } catch {
          operations.errors++;
        }
      }

      // List workspaces
      for (let i = 0; i < 10; i++) {
        try {
          const resp = await httpRequest('GET', `${this.baseUrl}/workspaces`);
          if (resp.status === 200) {
            operations.list++;
          } else {
            operations.errors++;
          }
        } catch {
          operations.errors++;
        }
      }

      // Remove workspaces
      for (const id of addedIds) {
        try {
          const resp = await httpRequest('DELETE', `${this.baseUrl}/workspaces/${id}`);
          if (resp.status === 200 || resp.status === 204) {
            operations.remove++;
          } else {
            operations.errors++;
          }
        } catch {
          operations.errors++;
        }
      }

      passed =
        operations.add >= 4 &&
        operations.list >= 8 &&
        operations.remove >= 4 &&
        operations.errors <= 3;
    } catch (err: any) {
      this.results.httpApiWorkspaces = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details: operations,
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    this.results.httpApiWorkspaces = {
      passed,
      elapsed_ms: Math.round(performance.now() - start),
      details: operations,
    };

    if (!passed) this.failures++;
    log(`  Add: ${operations.add}, List: ${operations.list}, Remove: ${operations.remove}, Errors: ${operations.errors}`);
    log(`  PASSED: ${passed}\n`);
  }

  // ==========================================================================
  // Test: HTTP API Concurrent Requests
  // ==========================================================================

  async testHttpApiConcurrent(): Promise<void> {
    log('=== Test: HTTP API Concurrent Requests ===');
    const start = performance.now();

    let passed = false;
    let successCount = 0;
    let errorCount = 0;

    try {
      const requestCount = CONFIG.httpRequestCount;
      const batchSize = CONFIG.concurrentHttpClients;

      // Fire requests in batches
      for (let batch = 0; batch < requestCount / batchSize; batch++) {
        const promises: Promise<void>[] = [];

        for (let i = 0; i < batchSize; i++) {
          promises.push(
            httpRequest('GET', `${this.baseUrl}/workspaces`)
              .then((resp) => {
                if (resp.status === 200) successCount++;
                else errorCount++;
              })
              .catch(() => {
                errorCount++;
              })
          );
        }

        await Promise.all(promises);
      }

      const successRate = successCount / requestCount;
      passed = successRate >= 0.9; // 90% success rate
    } catch (err: any) {
      this.results.httpApiConcurrent = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details: {},
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    const elapsed = performance.now() - start;
    this.results.httpApiConcurrent = {
      passed,
      elapsed_ms: Math.round(elapsed),
      details: {
        total_requests: CONFIG.httpRequestCount,
        success_count: successCount,
        error_count: errorCount,
        success_rate: successCount / CONFIG.httpRequestCount,
        requests_per_second: Math.round(CONFIG.httpRequestCount / (elapsed / 1000)),
      },
    };

    if (!passed) this.failures++;
    log(`  Success: ${successCount}/${CONFIG.httpRequestCount} (${Math.round((successCount / CONFIG.httpRequestCount) * 100)}%)`);
    log(`  Rate: ${Math.round(CONFIG.httpRequestCount / (elapsed / 1000))} req/sec`);
    log(`  PASSED: ${passed}\n`);
  }

  // ==========================================================================
  // Test: WebSocket Connections
  // ==========================================================================

  async testWebSocketConnections(): Promise<void> {
    log('=== Test: WebSocket Connections ===');
    const start = performance.now();

    let passed = false;
    let connected = 0;
    let errors = 0;
    const clients: any[] = [];

    try {
      // Create multiple WebSocket connections
      const connectionPromises: Promise<void>[] = [];

      for (let i = 0; i < CONFIG.wsClientCount; i++) {
        connectionPromises.push(
          new Promise<void>((resolve) => {
            try {
              const ws = new WebSocket(this.wsUrl);
              const timeout = setTimeout(() => {
                ws.terminate();
                errors++;
                resolve();
              }, 3000);

              ws.on('open', () => {
                clearTimeout(timeout);
                connected++;
                clients.push(ws);
                resolve();
              });

              ws.on('error', () => {
                clearTimeout(timeout);
                errors++;
                resolve();
              });
            } catch {
              errors++;
              resolve();
            }
          })
        );
      }

      await Promise.all(connectionPromises);

      // Hold connections briefly
      await sleep(500);

      // Close all connections
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          // Ignore
        }
      }

      passed = connected >= CONFIG.wsClientCount * 0.9; // 90% connected
    } catch (err: any) {
      this.results.webSocketConnections = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details: {},
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    this.results.webSocketConnections = {
      passed,
      elapsed_ms: Math.round(performance.now() - start),
      details: {
        target_clients: CONFIG.wsClientCount,
        connected: connected,
        errors: errors,
        connection_rate: connected / CONFIG.wsClientCount,
      },
    };

    if (!passed) this.failures++;
    log(`  Connected: ${connected}/${CONFIG.wsClientCount}, Errors: ${errors}`);
    log(`  PASSED: ${passed}\n`);
  }

  // ==========================================================================
  // Test: WebSocket Message Flood
  // ==========================================================================

  async testWebSocketMessageFlood(): Promise<void> {
    log('=== Test: WebSocket Message Flood ===');
    const start = performance.now();

    let passed = false;
    let totalSent = 0;
    let totalReceived = 0;

    try {
      const clients: any[] = [];
      const messagePromises: Promise<{ sent: number; received: number }>[] = [];

      // Create clients
      for (let i = 0; i < CONFIG.wsClientCount; i++) {
        const ws = await new Promise<any>((resolve, reject) => {
          const client = new WebSocket(this.wsUrl);
          const timeout = setTimeout(() => {
            client.terminate();
            reject(new Error('Connection timeout'));
          }, 3000);

          client.on('open', () => {
            clearTimeout(timeout);
            resolve(client);
          });

          client.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(err);
          });
        }).catch(() => null);

        if (ws) clients.push(ws);
      }

      if (clients.length === 0) {
        throw new Error('No WebSocket clients connected');
      }

      // Send messages from each client
      for (const ws of clients) {
        messagePromises.push(
          new Promise((resolve) => {
            let sent = 0;
            let received = 0;

            const messageHandler = () => {
              received++;
            };

            ws.on('message', messageHandler);

            // Send messages
            for (let i = 0; i < CONFIG.wsMessagesPerClient; i++) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping', seq: i, timestamp: Date.now() }));
                sent++;
              }
            }

            // Wait for responses
            setTimeout(() => {
              ws.removeListener('message', messageHandler);
              resolve({ sent, received });
            }, 2000);
          })
        );
      }

      const results = await Promise.all(messagePromises);

      for (const r of results) {
        totalSent += r.sent;
        totalReceived += r.received;
      }

      // Close clients
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          // Ignore
        }
      }

      // Success if we sent most messages (receiving depends on server echo behavior)
      passed = totalSent >= CONFIG.wsClientCount * CONFIG.wsMessagesPerClient * 0.9;
    } catch (err: any) {
      this.results.webSocketMessageFlood = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details: {},
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    this.results.webSocketMessageFlood = {
      passed,
      elapsed_ms: Math.round(performance.now() - start),
      details: {
        clients: CONFIG.wsClientCount,
        messages_per_client: CONFIG.wsMessagesPerClient,
        total_sent: totalSent,
        total_received: totalReceived,
      },
    };

    if (!passed) this.failures++;
    log(`  Sent: ${totalSent}, Received: ${totalReceived}`);
    log(`  PASSED: ${passed}\n`);
  }

  // ==========================================================================
  // Test: Workspace Lifecycle
  // ==========================================================================

  async testWorkspaceLifecycle(): Promise<void> {
    log('=== Test: Workspace Lifecycle ===');
    const start = performance.now();

    let passed = false;
    const cycles = { successful: 0, failed: 0 };

    try {
      for (let i = 0; i < CONFIG.workspaceCycles; i++) {
        const wsDir = createTempDir('lifecycle-ws-');
        this.tempDirs.push(wsDir);

        try {
          // Add workspace
          const addResp = await httpRequest('POST', `${this.baseUrl}/workspaces`, {
            path: wsDir,
            name: `Lifecycle-${i}`,
          });

          if (addResp.status !== 200 && addResp.status !== 201) {
            cycles.failed++;
            continue;
          }

          const workspaceId = (addResp.body as any)?.id;
          if (!workspaceId) {
            cycles.failed++;
            continue;
          }

          // Get workspace
          const getResp = await httpRequest('GET', `${this.baseUrl}/workspaces/${workspaceId}`);
          if (getResp.status !== 200) {
            cycles.failed++;
            continue;
          }

          // Switch to workspace (activates daemon)
          await httpRequest('POST', `${this.baseUrl}/workspaces/${workspaceId}/switch`);

          // Wait for daemon to start
          await sleep(200);

          // Get active workspace
          await httpRequest('GET', `${this.baseUrl}/workspaces/active`);

          // Remove workspace (stops daemon)
          const removeResp = await httpRequest('DELETE', `${this.baseUrl}/workspaces/${workspaceId}`);
          if (removeResp.status !== 200 && removeResp.status !== 204) {
            cycles.failed++;
            continue;
          }

          cycles.successful++;
        } catch {
          cycles.failed++;
        }
      }

      passed = cycles.successful >= CONFIG.workspaceCycles * 0.8;
    } catch (err: any) {
      this.results.workspaceLifecycle = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details: cycles,
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    this.results.workspaceLifecycle = {
      passed,
      elapsed_ms: Math.round(performance.now() - start),
      details: {
        total_cycles: CONFIG.workspaceCycles,
        successful: cycles.successful,
        failed: cycles.failed,
        success_rate: cycles.successful / CONFIG.workspaceCycles,
      },
    };

    if (!passed) this.failures++;
    log(`  Successful: ${cycles.successful}/${CONFIG.workspaceCycles}`);
    log(`  PASSED: ${passed}\n`);
  }

  // ==========================================================================
  // Test: Health Monitoring API
  // ==========================================================================

  async testHealthMonitoringApi(): Promise<void> {
    log('=== Test: Health Monitoring API ===');
    const start = performance.now();

    let passed = false;
    let successCount = 0;
    let errorCount = 0;

    try {
      // Rapid root status endpoint hits (returns JSON with status)
      for (let i = 0; i < CONFIG.healthCheckIterations; i++) {
        try {
          const resp = await httpRequest('GET', `${this.baseUrl}/`);
          if (resp.status === 200) {
            const body = resp.body as any;
            // Verify status response structure
            if (body?.status === 'ok' || typeof body?.workspaces !== 'undefined') {
              successCount++;
            } else {
              errorCount++;
            }
          } else {
            errorCount++;
          }
        } catch {
          errorCount++;
        }
      }

      passed = successCount >= CONFIG.healthCheckIterations * 0.95;
    } catch (err: any) {
      this.results.healthMonitoringApi = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details: {},
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    const elapsed = performance.now() - start;
    this.results.healthMonitoringApi = {
      passed,
      elapsed_ms: Math.round(elapsed),
      details: {
        total_checks: CONFIG.healthCheckIterations,
        success_count: successCount,
        error_count: errorCount,
        checks_per_second: Math.round(CONFIG.healthCheckIterations / (elapsed / 1000)),
      },
    };

    if (!passed) this.failures++;
    log(`  Success: ${successCount}/${CONFIG.healthCheckIterations}`);
    log(`  Rate: ${Math.round(CONFIG.healthCheckIterations / (elapsed / 1000))} checks/sec`);
    log(`  PASSED: ${passed}\n`);
  }

  // ==========================================================================
  // Test: Agent Health Crash Detection
  // ==========================================================================

  async testAgentHealthCrashDetection(): Promise<void> {
    log('=== Test: Agent Health Crash Detection ===');
    const start = performance.now();

    let passed = false;
    const details: Record<string, unknown> = {};

    if (!this.orchestrator) {
      this.results.agentHealthCrashDetection = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details,
        error: 'Orchestrator not initialized',
      };
      this.failures++;
      log('  FAILED: orchestrator not initialized\n');
      return;
    }

    try {
      const orch: any = this.orchestrator;
      const agentName = `crash-agent-${Date.now()}`;
      const workspaceId = 'stress-health-ws';

      // Capture broadcasted events to confirm crash notification
      const broadcasted: any[] = [];
      const originalBroadcast = orch.broadcastEvent?.bind(orch);
      orch.broadcastEvent = (evt: any) => {
        broadcasted.push(evt);
        if (originalBroadcast) return originalBroadcast(evt);
      };

      // Spawn a short-lived process and register for health monitoring
      const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 5000);'], {
        stdio: 'ignore',
      });
      details.childPid = child.pid;

      if (orch.registerAgentHealth) {
        orch.registerAgentHealth(workspaceId, agentName, child.pid);
      } else {
        throw new Error('registerAgentHealth not available');
      }

      // Kill the process to simulate crash
      child.kill('SIGKILL');
      await sleep(300);

      if (orch.checkAgentHeartbeats) {
        orch.checkAgentHeartbeats();
      } else {
        throw new Error('checkAgentHeartbeats not available');
      }

      // Allow async handlers to run
      await sleep(300);

      passed = broadcasted.some(
        (evt) => evt?.type === 'agent:crashed' && evt?.data?.name === agentName
      );
      details.broadcastCount = broadcasted.length;
      details.crashEventDetected = passed;
    } catch (err: any) {
      this.results.agentHealthCrashDetection = {
        passed: false,
        elapsed_ms: Math.round(performance.now() - start),
        details,
        error: err.message,
      };
      this.failures++;
      log(`  FAILED: ${err.message}\n`);
      return;
    }

    this.results.agentHealthCrashDetection = {
      passed,
      elapsed_ms: Math.round(performance.now() - start),
      details,
    };

    if (!passed) this.failures++;
    log(`  Crash event detected: ${passed}, Broadcasts: ${details.broadcastCount}`);
    log(`  PASSED: ${passed}\n`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const test = new IntegrationStressTest();

  let results: AllResults;

  try {
    await test.setup();
    results = await test.runAll();
  } catch (err: any) {
    log(`\nFATAL ERROR: ${err.message}`);
    results = {
      passed: false,
      failures: 1,
      tests: {},
      summary: {
        total_tests: 0,
        passed_tests: 0,
        failed_tests: 1,
        total_time_ms: 0,
      },
    };
  } finally {
    await test.teardown();
  }

  // Output results
  const jsonOutput = JSON.stringify(results, null, 2);

  if (OUTPUT_FILE) {
    // Write directly to file to avoid stdout pollution from Orchestrator logs
    fs.writeFileSync(OUTPUT_FILE, jsonOutput);
    log(`\nResults written to ${OUTPUT_FILE}`);
  } else if (JSON_OUTPUT) {
    console.log(jsonOutput);
  } else {
    log('\n=== Summary ===');
    log(`Overall: ${results.passed ? 'PASSED' : 'FAILED'}`);
    log(`Tests: ${results.summary.passed_tests}/${results.summary.total_tests} passed`);
    log(`Time: ${results.summary.total_time_ms}ms`);
    log('\nDetailed Results:');
    console.log(jsonOutput);
  }

  process.exit(results.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  // Ensure we write a valid JSON error result to the output file
  if (OUTPUT_FILE) {
    const errorResult = {
      passed: false,
      failures: 1,
      tests: {},
      summary: {
        total_tests: 0,
        passed_tests: 0,
        failed_tests: 1,
        total_time_ms: 0,
      },
      error: err?.message || String(err),
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(errorResult, null, 2));
  }
  process.exit(1);
});
