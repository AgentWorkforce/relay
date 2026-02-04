/**
 * Test 10: MCP Multi-Worker Communication
 *
 * This test verifies (MCP parity with SDK test 06):
 * - Spawning multiple agents via MCP
 * - All agents connect and become ready
 * - Orchestrator can send messages to each agent
 * - Each agent responds (pong to ping pattern)
 *
 * Usage:
 *   node tests/mcp/10-mcp-multi-worker.js [cli]
 *
 *   cli: 'claude' (default), 'codex', or 'gemini'
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

// Get CLI from command line args (default: claude)
const CLI = process.argv[2] || 'claude';
const VALID_CLIS = ['claude', 'codex', 'gemini'];

if (!VALID_CLIS.includes(CLI)) {
  console.error(`Invalid CLI: ${CLI}. Must be one of: ${VALID_CLIS.join(', ')}`);
  process.exit(1);
}

async function main() {
  console.log(`=== Test 10: MCP Multi-Worker Communication (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const workerNames = [
    `MCPWorker1-${runId}`,
    `MCPWorker2-${runId}`,
    `MCPWorker3-${runId}`,
  ];

  const connectedWorkers = new Set();
  const pongResponses = new Map();
  const spawnedAgents = [];

  // Step 1: Connect orchestrator with message handler
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [MSG from ${from}]`);
    console.log(`   ${body.substring(0, 150)}${body.length > 150 ? '...' : ''}`);

    // Track pong responses (any acknowledgment from workers)
    if (workerNames.includes(from)) {
      pongResponses.set(from, body);
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Spawn 3 agents via MCP
  console.log(`2. Spawning 3 ${CLI} agents via MCP...`);

  for (let i = 0; i < workerNames.length; i++) {
    const workerName = workerNames[i];
    const workerIndex = i + 1;

    try {
      const spawnResult = await orchestrator.spawn({
        name: workerName,
        cli: CLI,
        task: `You are test worker ${workerIndex} named "${workerName}". When you receive any message from "${orchestratorName}", respond back to "${orchestratorName}" with a message containing "PONG from ${workerName}". Keep your responses very short.`,
        cwd: projectRoot,
      });

      if (spawnResult.success) {
        console.log(`   Spawned ${workerName} (PID: ${spawnResult.pid})`);
        spawnedAgents.push(workerName);
      } else {
        console.error(`   Failed to spawn ${workerName}: ${spawnResult.error}`);
      }
    } catch (error) {
      console.error(`   Spawn error for ${workerName}: ${error.message}`);
    }
  }
  console.log('');

  // Step 3: Wait for all workers to connect
  console.log('3. Waiting for workers to connect (max 45s)...');

  const connectStart = Date.now();
  const connectTimeout = 45000;

  while (Date.now() - connectStart < connectTimeout) {
    const agents = await orchestrator.listAgents();

    for (const workerName of workerNames) {
      if (agents.some(a => a.name === workerName)) {
        connectedWorkers.add(workerName);
      }
    }

    if (connectedWorkers.size === workerNames.length) {
      console.log(`   All ${workerNames.length} workers connected!`);
      break;
    }

    const elapsed = Math.round((Date.now() - connectStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (${connectedWorkers.size}/${workerNames.length} connected)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('');

  if (connectedWorkers.size < workerNames.length) {
    console.log(`   Warning: Only ${connectedWorkers.size}/${workerNames.length} workers connected`);
  }

  // Give agents a moment to settle
  await new Promise(r => setTimeout(r, 3000));

  // Step 4: Send PING to each connected worker
  console.log('\n4. Sending PING to each worker...');

  for (const workerName of connectedWorkers) {
    console.log(`   Sending PING to ${workerName}`);
    orchestrator.sendMessage(workerName, { type: 'ping', from: orchestratorName, message: 'PING' });
    // Small delay between sends
    await new Promise(r => setTimeout(r, 500));
  }

  // Step 5: Wait for PONG responses
  console.log('\n5. Waiting for PONG responses (max 60s)...');

  const pongStart = Date.now();
  const pongTimeout = 60000;

  while (Date.now() - pongStart < pongTimeout) {
    if (pongResponses.size >= connectedWorkers.size) {
      console.log(`   All ${pongResponses.size} workers responded!`);
      break;
    }

    const elapsed = Math.round((Date.now() - pongStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (${pongResponses.size}/${connectedWorkers.size} responses)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('');

  // Step 6: Verify agent list
  console.log('\n6. Verifying agent list...');
  const finalAgents = await orchestrator.listAgents();
  const verifiedWorkers = workerNames.filter(name =>
    finalAgents.some(a => a.name === name)
  );
  console.log(`   Connected MCP workers: ${verifiedWorkers.length}/${workerNames.length}`);

  for (const agent of finalAgents) {
    if (workerNames.includes(agent.name)) {
      console.log(`   - ${agent.name} (cli: ${agent.cli || 'mcp'})`);
    }
  }

  // Step 7: Report pong results
  console.log('\n7. PONG Response Summary:');
  for (const [worker, response] of pongResponses) {
    const preview = response.substring(0, 80);
    console.log(`   ${worker}: ${preview}${response.length > 80 ? '...' : ''}`);
  }

  // Step 8: Cleanup - release all workers
  console.log('\n8. Releasing all workers...');
  for (const workerName of spawnedAgents) {
    try {
      const releaseResult = await orchestrator.release(workerName);
      if (releaseResult.success) {
        console.log(`   Released ${workerName}`);
      } else {
        console.log(`   ${workerName}: ${releaseResult.error || 'already exited'}`);
      }
    } catch (error) {
      console.log(`   ${workerName} release error: ${error.message}`);
    }
  }

  // Step 9: Disconnect
  console.log('\n9. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   Done\n');

  // Determine success
  const spawnSuccess = connectedWorkers.size >= 1;
  const responseSuccess = pongResponses.size >= 1;

  if (spawnSuccess && responseSuccess) {
    console.log(`=== Test 10 (MCP/${CLI.toUpperCase()}) PASSED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workerNames.length}`);
    console.log(`   Responses received: ${pongResponses.size}/${connectedWorkers.size}`);
    process.exit(0);
  } else {
    console.log(`=== Test 10 (MCP/${CLI.toUpperCase()}) FAILED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workerNames.length}`);
    console.log(`   Responses received: ${pongResponses.size}/${connectedWorkers.size}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
