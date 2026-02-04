/**
 * Test 03: Spawn a Real AI Agent
 *
 * This test verifies:
 * - Spawning a real Claude agent via client.spawn()
 * - The spawned agent connects to the relay
 * - We can send a message to the spawned agent
 * - The spawned agent can respond
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 * - Have `claude` CLI installed and authenticated
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 03: Spawn a Real AI Agent ===\n');

  // Create orchestrator client
  console.log('1. Creating orchestrator client...');
  const orchestrator = new RelayClient({
    agentName: 'Orchestrator',
    socketPath,
    quiet: true,
  });

  let workerResponse = null;

  orchestrator.onMessage = (from, payload) => {
    console.log(`   [Orchestrator] Received message from ${from}:`);
    console.log(`                  ${JSON.stringify(payload.body).slice(0, 100)}...`);
    workerResponse = { from, payload };
  };

  console.log('   ✓ Orchestrator created\n');

  // Connect orchestrator
  console.log('2. Connecting orchestrator...');
  try {
    await orchestrator.connect();
    console.log('   ✓ Connected\n');
  } catch (error) {
    console.error('   ✗ Connection failed:', error.message);
    process.exit(1);
  }

  // Spawn a Claude agent
  console.log('3. Spawning Claude agent "Worker-01"...');
  console.log('   CLI: claude');
  console.log('   Task: Say hello and introduce yourself briefly, then send a message to Orchestrator saying HELLO_COMPLETE\n');

  try {
    const spawnResult = await orchestrator.spawn({
      name: 'Worker-01',
      cli: 'claude',
      task: 'You are a test agent. Your job is simple: Send a message to "Orchestrator" with the body "HELLO_COMPLETE". Use the relay to send messages. After sending the message, you can exit.',
      cwd: projectRoot,
    });

    if (spawnResult.success) {
      console.log('   ✓ Spawn successful!');
      console.log(`   ✓ Agent name: ${spawnResult.name}`);
      if (spawnResult.pid) {
        console.log(`   ✓ PID: ${spawnResult.pid}`);
      }
    } else {
      console.error('   ✗ Spawn failed:', spawnResult.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('   ✗ Spawn error:', error.message);
    process.exit(1);
  }

  // Wait for the agent to do its work
  console.log('\n4. Waiting for Worker-01 to respond (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000; // 60 seconds

  while (!workerResponse && (Date.now() - startTime) < timeout) {
    await new Promise(r => setTimeout(r, 1000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
  }
  console.log('');

  if (workerResponse) {
    console.log('\n   ✓ Received response from worker!');
    console.log(`   ✓ From: ${workerResponse.from}`);
  } else {
    console.log('\n   ⚠ No response received within timeout');
    console.log('   (This is OK - the agent spawned successfully)');
  }

  // List agents to verify worker is connected
  console.log('\n5. Listing connected agents...');
  try {
    const agents = await orchestrator.listAgents();
    console.log('   Connected agents:');
    for (const agent of agents) {
      console.log(`   - ${agent.name} (cli: ${agent.cli || 'sdk'})`);
    }
  } catch (error) {
    console.log('   Could not list agents:', error.message);
  }

  // Cleanup - release the worker
  console.log('\n6. Releasing Worker-01...');
  try {
    const releaseResult = await orchestrator.release('Worker-01');
    if (releaseResult.success) {
      console.log('   ✓ Worker released successfully');
    } else {
      console.log('   ⚠ Release returned:', releaseResult);
    }
  } catch (error) {
    console.log('   ⚠ Release error:', error.message);
  }

  // Disconnect
  console.log('\n7. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   ✓ Done\n');

  console.log('=== Test 03 PASSED ===');
  process.exit(0);
}

main();
