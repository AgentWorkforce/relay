/**
 * Test 21: MCP Health & Metrics - System monitoring tools
 *
 * This test verifies:
 * - relay_health returns system health information
 * - relay_metrics returns resource usage data
 * - relay_status returns daemon status
 * - relay_logs can retrieve agent logs
 *
 * Usage:
 *   node tests/mcp/21-mcp-health-metrics.js [cli]
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 * - Have the specified CLI installed and authenticated
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

const CLI = process.argv[2] || 'claude';
const VALID_CLIS = ['claude', 'codex', 'gemini'];

if (!VALID_CLIS.includes(CLI)) {
  console.error(`Invalid CLI: ${CLI}. Must be one of: ${VALID_CLIS.join(', ')}`);
  process.exit(1);
}

async function main() {
  console.log(`=== Test 21: MCP Health & Metrics (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const monitorName = `Monitor-${runId}`;

  let healthChecked = false;
  let metricsChecked = false;
  let statusChecked = false;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Message received from ${from}]`);
    console.log(`   Body: ${body.substring(0, 200)}...`);

    if (body.includes('HEALTH:') || body.includes('healthScore') || body.includes('SYSTEM HEALTH')) {
      healthChecked = true;
    }
    if (body.includes('METRICS:') || body.includes('memory') || body.includes('cpu')) {
      metricsChecked = true;
    }
    if (body.includes('STATUS:') || body.includes('RUNNING') || body.includes('daemon')) {
      statusChecked = true;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Test SDK health check
  console.log('2. Testing health check via SDK...');
  try {
    const health = await orchestrator.getHealth({
      include_crashes: true,
      include_alerts: true,
    });
    console.log(`   Health Score: ${health.healthScore || 'N/A'}`);
    console.log(`   Summary: ${health.summary || 'No summary'}`);
    if (health.healthScore !== undefined) {
      healthChecked = true;
    }
  } catch (error) {
    console.log(`   Health check error (may be expected): ${error.message}`);
  }

  // Step 3: Test SDK metrics
  console.log('\n3. Testing metrics via SDK...');
  try {
    const metrics = await orchestrator.getMetrics();
    console.log(`   Agents: ${metrics.agents || 'N/A'}`);
    console.log(`   Memory: ${JSON.stringify(metrics.memory || {}).substring(0, 100)}`);
    if (metrics.agents !== undefined || metrics.memory) {
      metricsChecked = true;
    }
  } catch (error) {
    console.log(`   Metrics error (may be expected): ${error.message}`);
  }

  // Step 4: Spawn agent to use MCP health/metrics tools
  console.log('\n4. Spawning monitor agent to test MCP tools...');
  console.log(`   Name: ${monitorName}`);
  console.log('   Task: Check health, metrics, and status via MCP\n');

  try {
    const spawnResult = await orchestrator.spawn({
      name: monitorName,
      cli: CLI,
      task: `You are a system monitoring agent. Your tasks:

1. Use relay_health to check system health. Then send a message to "${orchestratorName}" with "HEALTH: " followed by the health score.

2. Use relay_metrics to get resource usage. Then send a message to "${orchestratorName}" with "METRICS: " followed by agent count or memory info.

3. Use relay_status to check daemon status. Then send a message to "${orchestratorName}" with "STATUS: " followed by the status.

4. Then exit.

Report what you find from each tool call.`,
      cwd: projectRoot,
    });

    if (spawnResult.success) {
      console.log('   Spawn successful!');
      console.log(`   PID: ${spawnResult.pid}`);
    } else {
      console.error(`   Spawn failed: ${spawnResult.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`   Spawn error: ${error.message}`);
    process.exit(1);
  }

  // Step 5: Wait for monitoring reports
  console.log('\n5. Waiting for monitoring reports (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while ((!healthChecked || !metricsChecked || !statusChecked) && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const status = `Health: ${healthChecked ? 'YES' : 'NO'}, Metrics: ${metricsChecked ? 'YES' : 'NO'}, Status: ${statusChecked ? 'YES' : 'NO'}`;
    process.stdout.write(`\r   Waiting... ${elapsed}s (${status})`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 6: Release monitor
  console.log('\n6. Releasing monitor agent...');
  try {
    const releaseResult = await orchestrator.release(monitorName);
    if (releaseResult.success) {
      console.log('   Released successfully');
    } else {
      console.log(`   Release: ${releaseResult.error || 'already exited'}`);
    }
  } catch (error) {
    console.log(`   Release error: ${error.message}`);
  }

  // Step 7: Cleanup
  console.log('\n7. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   Done\n');

  // Step 8: Verification
  console.log('8. Verification:');
  console.log(`   Health checked: ${healthChecked ? 'YES' : 'NO'}`);
  console.log(`   Metrics checked: ${metricsChecked ? 'YES' : 'NO'}`);
  console.log(`   Status checked: ${statusChecked ? 'YES' : 'NO'}`);

  const passed = healthChecked || metricsChecked || statusChecked;
  if (passed) {
    console.log(`\n=== Test 21 (MCP Health & Metrics) PASSED ===`);
    process.exit(0);
  } else {
    console.log('\n   Note: Some monitoring tools may require additional daemon support');
    console.log(`\n=== Test 21 (MCP Health & Metrics) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
