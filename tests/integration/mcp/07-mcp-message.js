/**
 * Test 07: MCP Message - Agent Sends Message via MCP
 *
 * This test verifies:
 * - Spawning an agent via SDK spawn()
 * - Giving the agent a task to send a message via MCP tools
 * - Orchestrator receives the message sent by the agent
 *
 * Usage:
 *   node tests/mcp/07-mcp-message.js [cli]
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
  console.log(`=== Test 07: MCP Message (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const workerName = `MCPSender-${runId}`;
  const testMessage = 'HELLO_FROM_CLAUDE';

  let messageReceived = false;
  let receivedPayload = null;

  // Step 1: Connect orchestrator with message handler
  console.log('1. Connecting orchestrator with message handler...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Message received]`);
    console.log(`   From: ${from}`);
    console.log(`   Body: ${body}`);

    if (from === workerName) {
      messageReceived = true;
      receivedPayload = payload.body;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected with message handler\n');

  // Step 2: Spawn Claude agent with a task to send a message
  console.log('2. Spawning Claude agent with messaging task...');
  console.log(`   Name: ${workerName}`);
  console.log(`   Task: Send message "${testMessage}" to ${orchestratorName}\n`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: workerName,
      cli: CLI,
      task: `You are a test agent. Your ONLY task is to send a single message. Use the relay tools to send a message to "${orchestratorName}" with the body "${testMessage}". After sending, you may exit.`,
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

  // Step 3: Wait for message from Claude agent
  console.log('\n3. Waiting for message from Claude agent (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while (!messageReceived && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 4: Verify message
  console.log('\n4. Verification:');
  if (messageReceived) {
    console.log('   Message received from Claude agent!');
    console.log(`   Expected: "${testMessage}"`);
    console.log(`   Received: "${receivedPayload}"`);

    const bodyMatch = typeof receivedPayload === 'string'
      ? receivedPayload.includes(testMessage)
      : JSON.stringify(receivedPayload).includes(testMessage);

    if (bodyMatch) {
      console.log('   Message content matches!');
    } else {
      console.log('   Note: Message received but content differs (may include extra text)');
    }
  } else {
    console.log('   No message received within timeout');
  }

  // Step 5: Release Claude agent
  console.log('\n5. Releasing Claude agent...');
  try {
    const releaseResult = await orchestrator.release(workerName);
    if (releaseResult.success) {
      console.log('   Released successfully');
    } else {
      console.log(`   Release: ${releaseResult.error || 'already exited'}`);
    }
  } catch (error) {
    console.log(`   Release error: ${error.message}`);
  }

  // Step 6: Cleanup
  console.log('\n6. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   Done\n');

  if (messageReceived) {
    console.log(`=== Test 07 (MCP/${CLI.toUpperCase()}) PASSED ===`);
    process.exit(0);
  } else {
    console.log(`=== Test 07 (MCP/${CLI.toUpperCase()}) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
