/**
 * Test 05b: Worker sends message to orchestrator
 *
 * Tests that:
 * 1. Worker process connects via SDK
 * 2. Worker sends completion message
 * 3. Orchestrator receives the message
 */

import { RelayClient } from '@agent-relay/sdk';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 05b: Worker Message to Orchestrator ===\n');

  const runId = Date.now().toString(36);
  const orchName = `Orch-${runId}`;
  const workerName = `Worker-${runId}`;

  let messageReceived = false;
  let receivedPayload = null;

  // Step 1: Connect orchestrator with message handler
  console.log('1. Connecting orchestrator with message handler...');
  const orchestrator = new RelayClient({
    agentName: orchName,
    socketPath,
    quiet: false, // Enable logs to see what's happening
  });

  orchestrator.onMessage = (from, payload, messageId) => {
    console.log(`\n   📨 onMessage triggered!`);
    console.log(`      From: ${from}`);
    console.log(`      Payload: ${JSON.stringify(payload)}`);
    console.log(`      MessageId: ${messageId}`);
    if (from === workerName) {
      messageReceived = true;
      receivedPayload = payload.body;
    }
  };

  await orchestrator.connect();
  console.log(`   ✓ Orchestrator "${orchName}" connected\n`);

  // Step 2: List agents before spawning worker
  console.log('2. Checking initial agent list...');
  let agents = await orchestrator.listAgents();
  console.log(`   Agents: ${agents.map(a => a.name).join(', ') || '(none)'}\n`);

  // Step 3: Spawn worker
  console.log('3. Spawning worker...');
  const workerScript = resolve(__dirname, 'worker.js');

  const proc = spawn('node', [workerScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AGENT_RELAY_NAME: workerName,
      ORCHESTRATOR: orchName,
      TASK_ID: 'message-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', d => console.log(`   ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));

  console.log(`   ✓ Worker spawned (PID: ${proc.pid})\n`);

  // Step 4: Wait for message
  console.log('4. Waiting for message from worker (max 15s)...');
  const start = Date.now();
  while (!messageReceived && Date.now() - start < 15000) {
    await new Promise(r => setTimeout(r, 500));
    // Periodically check agents
    if ((Date.now() - start) % 5000 < 500) {
      agents = await orchestrator.listAgents();
      console.log(`   [${Math.round((Date.now()-start)/1000)}s] Agents: ${agents.map(a => a.name).join(', ')}`);
    }
  }

  // Step 5: Verify
  console.log('\n5. Verification:');
  if (messageReceived) {
    console.log('   ✓ Message received from worker!');
    console.log(`   ✓ Payload type: ${receivedPayload?.type}`);
    console.log(`   ✓ Task ID: ${receivedPayload?.taskId}`);
  } else {
    console.log('   ✗ No message received within timeout');
    console.log('   Checking final agent list...');
    agents = await orchestrator.listAgents();
    console.log(`   Agents: ${agents.map(a => a.name).join(', ')}`);
  }

  // Cleanup
  console.log('\n6. Cleaning up...');
  proc.kill();
  orchestrator.disconnect();
  console.log('   ✓ Done\n');

  if (messageReceived && receivedPayload?.type === 'TASK_COMPLETE') {
    console.log('=== Test 05b PASSED ===');
    process.exit(0);
  } else {
    console.log('=== Test 05b FAILED ===');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
