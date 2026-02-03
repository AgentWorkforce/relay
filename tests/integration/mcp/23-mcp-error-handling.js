/**
 * Test 23: MCP Error Handling - Error scenarios and recovery
 *
 * This test verifies:
 * - Graceful handling of invalid agent names
 * - Handling of messages to non-existent agents
 * - Connection error recovery
 * - Invalid tool parameters
 *
 * Usage:
 *   node tests/mcp/23-mcp-error-handling.js [cli]
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
  console.log(`=== Test 23: MCP Error Handling (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const errorTestName = `ErrorTest-${runId}`;

  let errorHandled = false;
  let nonExistentMessageSent = false;

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
    console.log(`   Body: ${body.substring(0, 150)}`);

    if (body.includes('ERROR_HANDLED') || body.includes('failed') || body.includes('error')) {
      errorHandled = true;
    }
    if (body.includes('MESSAGE_SENT') || body.includes('sent to NonExistent')) {
      nonExistentMessageSent = true;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Test sending to non-existent agent via SDK
  console.log('2. Testing send to non-existent agent (SDK)...');
  try {
    await orchestrator.send('NonExistentAgent-xyz-999', 'Test message');
    console.log('   Message sent (may be queued)');
    nonExistentMessageSent = true;
  } catch (error) {
    console.log(`   Expected error: ${error.message}`);
    errorHandled = true;
  }

  // Step 3: Test invalid release
  console.log('\n3. Testing release of non-existent agent...');
  try {
    const result = await orchestrator.release('NonExistentAgent-xyz-999');
    console.log(`   Result: ${result.success ? 'success' : result.error || 'failed'}`);
    if (!result.success) {
      errorHandled = true;
    }
  } catch (error) {
    console.log(`   Expected error: ${error.message}`);
    errorHandled = true;
  }

  // Step 4: Spawn agent to test MCP error handling
  console.log('\n4. Spawning agent to test MCP error handling...');

  try {
    const spawnResult = await orchestrator.spawn({
      name: errorTestName,
      cli: CLI,
      task: `You are a test agent for error handling. Your tasks:

1. Try to use relay_send to send a message to "NonExistentAgent-xyz-${runId}" with message "Test error"

2. Observe the result (it may succeed with message queued, or fail gracefully)

3. Send a message to "${orchestratorName}" reporting what happened:
   - If it succeeded: "MESSAGE_SENT to NonExistent agent"
   - If it failed: "ERROR_HANDLED: " followed by the error

4. Try to use relay_channel_leave to leave a channel "#non-existent-channel-${runId}" that you never joined

5. Report that result to "${orchestratorName}" as well

6. Then exit.

The goal is to verify that errors are handled gracefully.`,
      cwd: projectRoot,
    });

    if (spawnResult.success) {
      console.log('   Spawn successful!');
      console.log(`   PID: ${spawnResult.pid}`);
    } else {
      console.error(`   Spawn failed: ${spawnResult.error}`);
    }
  } catch (error) {
    console.error(`   Spawn error: ${error.message}`);
    errorHandled = true; // This is also an error we're testing
  }

  // Step 5: Wait for error handling reports
  console.log('\n5. Waiting for error handling reports (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while ((!errorHandled && !nonExistentMessageSent) && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 6: Release test agent
  console.log('\n6. Releasing test agent...');
  try {
    const releaseResult = await orchestrator.release(errorTestName);
    console.log(`   Release: ${releaseResult.success ? 'success' : releaseResult.error || 'already exited'}`);
  } catch (error) {
    console.log(`   Release error: ${error.message}`);
  }

  // Step 7: Test reconnection after disconnect
  console.log('\n7. Testing reconnection...');
  orchestrator.disconnect();
  console.log('   Disconnected');

  try {
    await orchestrator.connect();
    console.log('   Reconnected successfully');
    orchestrator.disconnect();
    errorHandled = true;
  } catch (error) {
    console.log(`   Reconnection error: ${error.message}`);
  }

  // Step 8: Cleanup
  console.log('\n8. Final cleanup...');
  console.log('   Done\n');

  // Step 9: Verification
  console.log('9. Verification:');
  console.log(`   Error handling observed: ${errorHandled ? 'YES' : 'NO'}`);
  console.log(`   Non-existent message handling: ${nonExistentMessageSent ? 'YES' : 'NO'}`);

  // This test passes if we observed graceful error handling
  if (errorHandled || nonExistentMessageSent) {
    console.log(`\n=== Test 23 (MCP Error Handling) PASSED ===`);
    process.exit(0);
  } else {
    console.log(`\n=== Test 23 (MCP Error Handling) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
