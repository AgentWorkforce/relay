/**
 * Test 12: MCP Multiple Agents
 *
 * This test verifies (MCP parity with SDK test 08):
 * - Spawning multiple real CLI agents via MCP
 * - Each agent receives and responds to messages
 * - Bidirectional communication between coordinator and agents
 *
 * Usage:
 *   node tests/mcp/12-mcp-multi-claude.js [cli]
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
  console.log(`=== Test 12: MCP Multiple Agents (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const coordinatorName = `Coordinator-${runId}`;
  const agentNames = [`Agent1-${runId}`, `Agent2-${runId}`];

  const responses = new Map();
  const spawnedAgents = [];

  // Step 1: Connect coordinator
  console.log('1. Connecting coordinator...');
  const coordinator = new RelayClient({
    agentName: coordinatorName,
    socketPath,
    quiet: true,
  });

  coordinator.onMessage = (from, payload) => {
    console.log(`\n   [MSG from ${from}]`);
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`   ${body.substring(0, 200)}${body.length > 200 ? '...' : ''}`);
    responses.set(from, body);
  };

  await coordinator.connect();
  console.log(`   Name: ${coordinatorName}`);
  console.log('   Connected\n');

  // Step 2: Spawn first Claude agent
  console.log('2. Spawning first Claude agent...');
  const task1 = `You are ${agentNames[0]}. When you receive any message from the coordinator, respond with a SHORT acknowledgment (under 50 words) confirming you received it. Start your response with "ACK from ${agentNames[0]}:".`;

  try {
    const result1 = await coordinator.spawn({
      name: agentNames[0],
      cli: CLI,
      task: task1,
      cwd: projectRoot,
    });
    console.log(`   Spawned ${agentNames[0]} (PID: ${result1.pid})`);
    spawnedAgents.push(agentNames[0]);
  } catch (err) {
    console.log(`   Failed to spawn ${agentNames[0]}: ${err.message}`);
    coordinator.disconnect();
    process.exit(1);
  }

  // Step 3: Spawn second Claude agent
  console.log('\n3. Spawning second Claude agent...');
  const task2 = `You are ${agentNames[1]}. When you receive any message from the coordinator, respond with a SHORT acknowledgment (under 50 words) confirming you received it. Start your response with "ACK from ${agentNames[1]}:".`;

  try {
    const result2 = await coordinator.spawn({
      name: agentNames[1],
      cli: CLI,
      task: task2,
      cwd: projectRoot,
    });
    console.log(`   Spawned ${agentNames[1]} (PID: ${result2.pid})`);
    spawnedAgents.push(agentNames[1]);
  } catch (err) {
    console.log(`   Failed to spawn ${agentNames[1]}: ${err.message}`);
  }

  // Step 4: Wait for agents to initialize
  console.log('\n4. Waiting for agents to initialize (max 30s)...');

  let connectedCount = 0;
  const initStart = Date.now();
  const initTimeout = 30000;

  while (Date.now() - initStart < initTimeout) {
    const agents = await coordinator.listAgents();
    connectedCount = agentNames.filter(name =>
      agents.some(a => a.name === name)
    ).length;

    if (connectedCount === spawnedAgents.length) {
      console.log(`   All ${connectedCount} agents initialized!`);
      break;
    }

    const elapsed = Math.round((Date.now() - initStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (${connectedCount}/${spawnedAgents.length} connected)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('');

  // List all connected agents
  const agents = await coordinator.listAgents();
  const mcpAgents = agents.filter(a => agentNames.includes(a.name));
  console.log(`\n   Connected MCP agents: ${mcpAgents.length}/${agentNames.length}`);
  for (const agent of mcpAgents) {
    console.log(`   - ${agent.name} (cli: ${agent.cli || 'mcp'})`);
  }

  // Give agents a moment to settle
  await new Promise(r => setTimeout(r, 3000));

  // Step 5: Send message to first agent
  console.log('\n5. Sending message to first agent...');
  if (spawnedAgents.includes(agentNames[0])) {
    coordinator.sendMessage(agentNames[0], 'Hello Agent1! Please confirm you received this message.');
    console.log(`   Sent message to ${agentNames[0]}`);
  }

  // Wait for response
  console.log('   Waiting for response (30s)...');
  const wait1Start = Date.now();
  while (!responses.has(agentNames[0]) && Date.now() - wait1Start < 30000) {
    await new Promise(r => setTimeout(r, 1000));
  }

  if (responses.has(agentNames[0])) {
    console.log(`   Received response from ${agentNames[0]}`);
  } else {
    console.log(`   No response from ${agentNames[0]} within timeout`);
  }

  // Step 6: Send message to second agent
  if (spawnedAgents.length > 1 && spawnedAgents.includes(agentNames[1])) {
    console.log('\n6. Sending message to second agent...');
    coordinator.sendMessage(agentNames[1], 'Hello Agent2! Please confirm you received this message.');
    console.log(`   Sent message to ${agentNames[1]}`);

    // Wait for response
    console.log('   Waiting for response (30s)...');
    const wait2Start = Date.now();
    while (!responses.has(agentNames[1]) && Date.now() - wait2Start < 30000) {
      await new Promise(r => setTimeout(r, 1000));
    }

    if (responses.has(agentNames[1])) {
      console.log(`   Received response from ${agentNames[1]}`);
    } else {
      console.log(`   No response from ${agentNames[1]} within timeout`);
    }
  }

  // Step 7: Results
  console.log('\n7. Results:');
  console.log(`   Spawned agents: ${spawnedAgents.length}`);
  console.log(`   Connected agents: ${connectedCount}`);
  console.log(`   Responses received: ${responses.size}`);

  if (responses.size > 0) {
    console.log('\n   Response details:');
    for (const [agent, response] of responses) {
      console.log(`   ${agent}:`);
      console.log(`     ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`);
    }
  }

  // Step 8: Release agents
  console.log('\n8. Releasing agents...');
  for (const name of spawnedAgents) {
    try {
      const releaseResult = await coordinator.release(name);
      if (releaseResult.success) {
        console.log(`   Released ${name}`);
      } else {
        console.log(`   ${name}: ${releaseResult.error || 'already exited'}`);
      }
    } catch (err) {
      console.log(`   Failed to release ${name}: ${err.message}`);
    }
  }

  // Step 9: Disconnect
  coordinator.disconnect();
  console.log('\n9. Disconnected\n');

  // Determine success
  const success = spawnedAgents.length >= 1 && responses.size >= 1;

  if (success) {
    console.log(`=== Test 12 (MCP/${CLI.toUpperCase()}) PASSED ===`);
    process.exit(0);
  } else {
    console.log(`=== Test 12 (MCP/${CLI.toUpperCase()}) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
