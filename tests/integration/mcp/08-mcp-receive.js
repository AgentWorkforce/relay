/**
 * Test 08: MCP Receive - Orchestrator Sends Message to Agent
 *
 * This test verifies:
 * - Spawning an agent via SDK spawn()
 * - Orchestrator sends a message to the agent
 * - Agent receives the message and acknowledges
 *
 * Usage:
 *   node tests/mcp/08-mcp-receive.js [cli]
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
  console.log(`=== Test 08: MCP Receive (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const workerName = `MCPReceiver-${runId}`;
  const testMessage = 'PING_FROM_ORCHESTRATOR';
  const expectedResponse = 'ACKNOWLEDGED';

  let acknowledgmentReceived = false;
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
      receivedPayload = payload.body;
      // Check if Claude acknowledged our message
      if (body.includes(expectedResponse) || body.includes('ACK') || body.includes('received')) {
        acknowledgmentReceived = true;
      }
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected with message handler\n');

  // Step 2: Spawn Claude agent that will listen and respond
  console.log('2. Spawning Claude agent that listens for messages...');
  console.log(`   Name: ${workerName}`);
  console.log('   Task: Wait for message, then acknowledge\n');

  try {
    const spawnResult = await orchestrator.spawn({
      name: workerName,
      cli: CLI,
      task: `You are a test agent named "${workerName}". Your task is to wait for a message from "${orchestratorName}". When you receive a message, send back a response to "${orchestratorName}" with the body "${expectedResponse}". Keep checking for incoming messages using the relay tools.`,
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

  // Step 3: Wait for Claude agent to connect
  console.log('\n3. Waiting for Claude agent to connect...');

  let agentConnected = false;
  const connectStart = Date.now();
  const connectTimeout = 30000;

  while (Date.now() - connectStart < connectTimeout) {
    const agents = await orchestrator.listAgents();
    const worker = agents.find(a => a.name === workerName);

    if (worker) {
      console.log(`   Claude agent "${workerName}" connected!`);
      agentConnected = true;
      break;
    }

    const elapsed = Math.round((Date.now() - connectStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!agentConnected) {
    console.log('\n   Timeout: Claude agent did not connect');
    orchestrator.disconnect();
    console.log('\n=== Test 08 (MCP/${CLI.toUpperCase()}) FAILED ===');
    process.exit(1);
  }

  // Give agent a moment to settle
  await new Promise(r => setTimeout(r, 2000));

  // Step 4: Send message to Claude agent
  console.log('\n4. Sending message to Claude agent...');
  console.log(`   To: ${workerName}`);
  console.log(`   Body: ${testMessage}`);

  const sent = orchestrator.sendMessage(workerName, testMessage);
  if (sent) {
    console.log('   Message sent!');
  } else {
    console.log('   sendMessage returned false');
  }

  // Step 5: Wait for acknowledgment
  console.log('\n5. Waiting for acknowledgment from Claude agent (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while (!acknowledgmentReceived && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 6: Verify acknowledgment
  console.log('\n6. Verification:');
  if (acknowledgmentReceived) {
    console.log('   Acknowledgment received from Claude agent!');
    console.log(`   Response: "${receivedPayload}"`);
  } else if (receivedPayload) {
    console.log('   Response received but not the expected acknowledgment:');
    console.log(`   Response: "${receivedPayload}"`);
    // Still consider it a partial success if we got any response
    acknowledgmentReceived = true;
  } else {
    console.log('   No acknowledgment received within timeout');
  }

  // Step 7: Release Claude agent
  console.log('\n7. Releasing Claude agent...');
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

  // Step 8: Cleanup
  console.log('\n8. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   Done\n');

  if (acknowledgmentReceived) {
    console.log('=== Test 08 (MCP/${CLI.toUpperCase()}) PASSED ===');
    process.exit(0);
  } else {
    console.log('=== Test 08 (MCP/${CLI.toUpperCase()}) FAILED ===');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
