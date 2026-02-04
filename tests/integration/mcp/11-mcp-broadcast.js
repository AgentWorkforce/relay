/**
 * Test 11: MCP Broadcast Messages
 *
 * This test verifies (MCP parity with SDK test 07):
 * - Spawning multiple agents via MCP (Alice, Bob, Charlie)
 * - Orchestrator instructs one agent to broadcast to others
 * - Agents receive messages from other agents
 * - Broadcast acknowledgments are tracked
 *
 * Usage:
 *   node tests/mcp/11-mcp-broadcast.js [cli]
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
  console.log(`=== Test 11: MCP Broadcast Messages (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const workerNames = [
    `Alice-${runId}`,
    `Bob-${runId}`,
    `Charlie-${runId}`,
  ];

  const connectedWorkers = new Set();
  const broadcastAcks = [];
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

    // Track acknowledgments of broadcasts
    if (workerNames.includes(from)) {
      broadcastAcks.push({ from, body, timestamp: Date.now() });
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Spawn 3 Claude agents (Alice, Bob, Charlie) via MCP
  console.log('2. Spawning Claude agents (Alice, Bob, Charlie) via MCP...');

  const allWorkersJson = JSON.stringify(workerNames);

  for (let i = 0; i < workerNames.length; i++) {
    const workerName = workerNames[i];
    const otherWorkers = workerNames.filter(n => n !== workerName);

    try {
      const spawnResult = await orchestrator.spawn({
        name: workerName,
        cli: CLI,
        task: `You are "${workerName}" in a group chat scenario. The other participants are: ${otherWorkers.join(', ')}. The orchestrator is "${orchestratorName}".

When the orchestrator asks you to broadcast:
1. Send a message to EACH other participant (${otherWorkers.join(' and ')})
2. Your message should say "Hello from ${workerName}!"
3. After sending to all, send a confirmation to the orchestrator saying "BROADCAST_DONE"

When you receive a message from another participant (Alice, Bob, or Charlie):
1. Send an acknowledgment to the orchestrator saying "ACK: received message from [sender]"

Keep all responses very short and simple.`,
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

  // Step 4: Tell Alice to broadcast to everyone
  console.log('\n4. Telling Alice to broadcast to everyone...');
  const aliceName = workerNames[0];

  if (connectedWorkers.has(aliceName)) {
    orchestrator.sendMessage(aliceName, 'Please broadcast a greeting to all other participants now.');
    console.log(`   Sent broadcast instruction to ${aliceName}`);
  } else {
    console.log(`   ${aliceName} not connected, skipping`);
  }

  // Wait for broadcast acknowledgments
  console.log('\n5. Waiting for broadcast acknowledgments (30s)...');
  await new Promise(r => setTimeout(r, 30000));

  const aliceBroadcastAcks = broadcastAcks.length;
  console.log(`   Acknowledgments after Alice's broadcast: ${aliceBroadcastAcks}`);

  // Step 6: Tell all workers to broadcast
  console.log('\n6. Telling all workers to broadcast...');
  const broadcastStartCount = broadcastAcks.length;

  for (const workerName of connectedWorkers) {
    orchestrator.sendMessage(workerName, 'Please broadcast a greeting to all other participants now.');
    console.log(`   Sent broadcast instruction to ${workerName}`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Wait for all broadcasts to complete
  console.log('\n7. Waiting for all broadcast acknowledgments (45s)...');

  const broadcastStart = Date.now();
  const broadcastTimeout = 45000;

  while (Date.now() - broadcastStart < broadcastTimeout) {
    const newAcks = broadcastAcks.length - broadcastStartCount;
    const elapsed = Math.round((Date.now() - broadcastStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (${newAcks} new acknowledgments)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('');

  // Calculate expected acks: each worker broadcasts to 2 others, so 3 workers * 2 = 6 messages
  // Plus broadcast_done confirmations
  const totalAcks = broadcastAcks.length;
  console.log(`\n   Total acknowledgments received: ${totalAcks}`);

  // Step 8: Summarize broadcast results
  console.log('\n8. Broadcast Summary:');
  const acksByWorker = {};
  for (const ack of broadcastAcks) {
    if (!acksByWorker[ack.from]) {
      acksByWorker[ack.from] = [];
    }
    acksByWorker[ack.from].push(ack.body.substring(0, 60));
  }

  for (const [worker, acks] of Object.entries(acksByWorker)) {
    console.log(`   ${worker}: ${acks.length} message(s)`);
    for (const ack of acks.slice(0, 3)) {
      console.log(`     - ${ack}...`);
    }
    if (acks.length > 3) {
      console.log(`     ... and ${acks.length - 3} more`);
    }
  }

  // Step 9: Cleanup - release all workers
  console.log('\n9. Releasing all workers...');
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

  // Step 10: Disconnect
  console.log('\n10. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('    Done\n');

  // Determine success - need at least some acknowledgments
  const success = connectedWorkers.size >= 2 && totalAcks >= 1;

  if (success) {
    console.log(`=== Test 11 (MCP/${CLI.toUpperCase()}) PASSED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workerNames.length}`);
    console.log(`   Total acknowledgments: ${totalAcks}`);
    process.exit(0);
  } else {
    console.log(`=== Test 11 (MCP/${CLI.toUpperCase()}) FAILED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workerNames.length}`);
    console.log(`   Total acknowledgments: ${totalAcks}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
