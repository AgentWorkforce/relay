/**
 * Test 08: Multiple Claude Agents
 *
 * Spawn multiple real Claude CLI agents and have them communicate.
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 08: Multiple Claude Agents ===\n');

  const runId = Date.now().toString(36);
  const orchName = `Coordinator-${runId}`;
  const agentNames = [`Agent1-${runId}`, `Agent2-${runId}`];

  const responses = new Map();
  const spawnedAgents = [];

  // Step 1: Connect coordinator
  console.log('1. Connecting coordinator...');
  const coordinator = new RelayClient({
    agentName: orchName,
    socketPath,
    quiet: true,
  });

  coordinator.onMessage = (from, payload) => {
    console.log(`\n   [MSG from ${from}]`);
    const body = payload.body;
    if (typeof body === 'string') {
      console.log(`   ${body.substring(0, 200)}${body.length > 200 ? '...' : ''}`);
    } else {
      console.log(`   ${JSON.stringify(body).substring(0, 200)}`);
    }
    responses.set(from, body);
  };

  await coordinator.connect();
  console.log('   ✓ Connected\n');

  // Step 2: Spawn first Claude agent
  console.log('2. Spawning first Claude agent...');
  const task1 = `You are ${agentNames[0]}. When you receive a message, respond with a single short sentence acknowledging it. Keep responses under 50 words.`;

  try {
    const result1 = await coordinator.spawn({
      name: agentNames[0],
      cli: 'claude',
      task: task1,
      orchestrator: orchName,
    });
    console.log(`   ✓ ${agentNames[0]} spawned (PID: ${result1.pid})`);
    spawnedAgents.push(agentNames[0]);
  } catch (err) {
    console.log(`   ✗ Failed to spawn: ${err.message}`);
    coordinator.disconnect();
    process.exit(1);
  }

  // Step 3: Spawn second Claude agent
  console.log('\n3. Spawning second Claude agent...');
  const task2 = `You are ${agentNames[1]}. When you receive a message, respond with a single short sentence acknowledging it. Keep responses under 50 words.`;

  try {
    const result2 = await coordinator.spawn({
      name: agentNames[1],
      cli: 'claude',
      task: task2,
      orchestrator: orchName,
    });
    console.log(`   ✓ ${agentNames[1]} spawned (PID: ${result2.pid})`);
    spawnedAgents.push(agentNames[1]);
  } catch (err) {
    console.log(`   ✗ Failed to spawn: ${err.message}`);
  }

  // Wait for agents to initialize
  console.log('\n4. Waiting for agents to initialize...');
  await new Promise(r => setTimeout(r, 5000));

  // Check agent list
  const agents = await coordinator.listAgents();
  const connectedAgents = agentNames.filter(name =>
    agents.some(a => a.name === name)
  );
  console.log(`   Connected: ${connectedAgents.length}/${agentNames.length}`);

  // Step 5: Send message to first agent
  console.log('\n5. Sending message to first agent...');
  coordinator.sendMessage(agentNames[0], 'Hello! Please confirm you received this message.');

  // Wait for response
  await new Promise(r => setTimeout(r, 10000));

  // Step 6: Send message to second agent
  if (spawnedAgents.length > 1) {
    console.log('\n6. Sending message to second agent...');
    coordinator.sendMessage(agentNames[1], 'Hello! Please confirm you received this message.');

    // Wait for response
    await new Promise(r => setTimeout(r, 10000));
  }

  // Results
  console.log('\n7. Results:');
  console.log(`   Spawned agents: ${spawnedAgents.length}`);
  console.log(`   Responses received: ${responses.size}`);

  // Cleanup
  console.log('\n8. Releasing agents...');
  for (const name of spawnedAgents) {
    try {
      await coordinator.release(name);
      console.log(`   ✓ Released ${name}`);
    } catch (err) {
      console.log(`   ✗ Failed to release ${name}: ${err.message}`);
    }
  }

  coordinator.disconnect();
  console.log('\n   ✓ Done\n');

  const success = spawnedAgents.length >= 1 && responses.size >= 1;
  if (success) {
    console.log('=== Test 08 PASSED ===');
    process.exit(0);
  } else {
    console.log('=== Test 08 FAILED ===');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
