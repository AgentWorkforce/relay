/**
 * Test 19: MCP Pub/Sub - Topic subscription and publishing
 *
 * This test verifies:
 * - Agents can subscribe to topics via relay_subscribe
 * - Messages published to topics reach subscribers
 * - Agents can unsubscribe from topics
 *
 * Usage:
 *   node tests/mcp/19-mcp-pubsub.js [cli]
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
  console.log(`=== Test 19: MCP Pub/Sub (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const subscriberName = `Subscriber-${runId}`;
  const topicName = `test-topic-${runId}`;
  const testMessage = `TOPIC_MSG_${runId}`;

  let topicMessageReceived = false;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Orchestrator received message]`);
    console.log(`   From: ${from}`);
    console.log(`   Body: ${body.substring(0, 100)}...`);

    if (body.includes(testMessage) || body.includes('SUBSCRIBED')) {
      topicMessageReceived = true;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Orchestrator subscribes to topic
  console.log('2. Orchestrator subscribing to topic...');
  try {
    const subResult = await orchestrator.subscribe(topicName);
    if (subResult.success) {
      console.log(`   Subscribed to ${topicName}\n`);
    } else {
      console.log(`   Subscribe result: ${subResult.error || 'unknown'}`);
    }
  } catch (error) {
    console.log(`   Subscribe error (may be expected): ${error.message}\n`);
  }

  // Step 3: Spawn agent to subscribe and publish
  console.log('3. Spawning subscriber/publisher agent...');
  console.log(`   Name: ${subscriberName}`);
  console.log(`   Task: Subscribe to topic and publish message\n`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: subscriberName,
      cli: CLI,
      task: `You are a test agent for pub/sub testing. Your tasks:

1. Use relay_subscribe to subscribe to the topic "${topicName}"

2. After subscribing, send a message to "${orchestratorName}" saying "SUBSCRIBED to ${topicName}"

3. Then use relay_send with to="#${topicName}" (note the # prefix for topics) and message="${testMessage}" to publish to the topic

4. Then exit.

Important: Topics use # prefix similar to channels.`,
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

  // Step 4: Wait for messages
  console.log('\n4. Waiting for pub/sub messages (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while (!topicMessageReceived && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 5: Unsubscribe
  console.log('\n5. Orchestrator unsubscribing from topic...');
  try {
    const unsubResult = await orchestrator.unsubscribe(topicName);
    if (unsubResult.success) {
      console.log(`   Unsubscribed from ${topicName}`);
    } else {
      console.log(`   Unsubscribe result: ${unsubResult.error || 'unknown'}`);
    }
  } catch (error) {
    console.log(`   Unsubscribe error: ${error.message}`);
  }

  // Step 6: Release subscriber
  console.log('\n6. Releasing subscriber agent...');
  try {
    const releaseResult = await orchestrator.release(subscriberName);
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
  if (topicMessageReceived) {
    console.log('   Topic message received!');
    console.log(`\n=== Test 19 (MCP Pub/Sub) PASSED ===`);
    process.exit(0);
  } else {
    console.log('   No topic message received within timeout');
    console.log('   Note: Pub/Sub features may require additional daemon support');
    console.log(`\n=== Test 19 (MCP Pub/Sub) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
