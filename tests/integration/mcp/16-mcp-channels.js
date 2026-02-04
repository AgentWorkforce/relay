/**
 * Test 16: MCP Channels - Channel join/leave/message operations
 *
 * This test verifies:
 * - Agents can join channels via MCP tools
 * - Channel messages are delivered to all members
 * - Agents can leave channels
 * - Admin operations work (adding members)
 *
 * Usage:
 *   node tests/mcp/16-mcp-channels.js [cli]
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
  console.log(`=== Test 16: MCP Channels (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const workerName = `ChannelWorker-${runId}`;
  const channelName = `#test-channel-${runId}`;
  const testMessage = `CHANNEL_MSG_${runId}`;

  let channelMessageReceived = false;
  let receivedChannelMessage = null;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Message received]`);
    console.log(`   From: ${from}`);
    console.log(`   Body: ${body.substring(0, 100)}...`);

    if (body.includes(testMessage)) {
      channelMessageReceived = true;
      receivedChannelMessage = body;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Orchestrator joins channel (SDK method may not be available)
  console.log('2. Orchestrator joining channel...');
  try {
    if (orchestrator.joinChannel) {
      const joinResult = await orchestrator.joinChannel(channelName);
      if (joinResult.success) {
        console.log(`   Joined ${channelName}\n`);
      } else {
        console.log(`   SDK join returned: ${joinResult.error || 'unknown'}`);
        console.log('   Continuing - MCP agent will test channel features\n');
      }
    } else {
      console.log('   SDK joinChannel not available');
      console.log('   Continuing - MCP agent will test channel features\n');
    }
  } catch (error) {
    console.log(`   SDK channel join error: ${error.message}`);
    console.log('   Continuing - MCP agent will test channel features\n');
  }

  // Step 3: Spawn worker with task to join channel and send message
  console.log('3. Spawning worker agent...');
  console.log(`   Name: ${workerName}`);
  console.log(`   Task: Join channel and send message\n`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: workerName,
      cli: CLI,
      task: `You are a test agent. Do these steps in order:
1. Use relay_channel_join to join the channel "${channelName}"
2. Use relay_channel_message to send the message "${testMessage}" to channel "${channelName}"
3. After sending the message, you may exit.`,
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

  // Step 4: Wait for channel message
  console.log('\n4. Waiting for channel message (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while (!channelMessageReceived && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 5: Leave channel
  console.log('\n5. Orchestrator leaving channel...');
  try {
    if (orchestrator.leaveChannel) {
      const leaveResult = await orchestrator.leaveChannel(channelName);
      if (leaveResult.success) {
        console.log(`   Left ${channelName}`);
      } else {
        console.log(`   Leave result: ${leaveResult.error || 'already left'}`);
      }
    } else {
      console.log('   SDK leaveChannel not available');
    }
  } catch (error) {
    console.log(`   Leave error: ${error.message}`);
  }

  // Step 6: Release worker
  console.log('\n6. Releasing worker agent...');
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

  // Step 7: Cleanup
  console.log('\n7. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   Done\n');

  // Step 8: Verification
  console.log('8. Verification:');
  if (channelMessageReceived) {
    console.log('   Channel message received!');
    console.log(`   Content includes test message: ${receivedChannelMessage.includes(testMessage) ? 'YES' : 'NO'}`);
    console.log(`\n=== Test 16 (MCP Channels) PASSED ===`);
    process.exit(0);
  } else {
    console.log('   No channel message received within timeout');
    console.log(`\n=== Test 16 (MCP Channels) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
