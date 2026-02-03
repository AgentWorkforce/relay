/**
 * Test 02: Send Messages Between Agents
 *
 * This test verifies:
 * - Setting up onMessage callback
 * - Sending messages between two agents
 * - Receiving messages with correct payload
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 02: Send Messages Between Agents ===\n');

  // Track received messages
  const receivedMessages = [];
  let replyReceived = false;

  // Create two agents
  console.log('1. Creating Agent A (sender)...');
  const agentA = new RelayClient({
    agentName: 'AgentA',
    socketPath,
    quiet: true,
  });

  // Set up message handler for Agent A (for replies)
  agentA.onMessage = (from, payload) => {
    console.log(`   [AgentA] Received reply from ${from}: ${JSON.stringify(payload.body)}`);
    replyReceived = true;
  };
  console.log('   ✓ Agent A created\n');

  console.log('2. Creating Agent B (receiver)...');
  const agentB = new RelayClient({
    agentName: 'AgentB',
    socketPath,
    quiet: true,
  });

  // Set up message handler for Agent B BEFORE connecting
  agentB.onMessage = (from, payload, messageId, meta) => {
    console.log(`   [AgentB] Received message from ${from}:`);
    console.log(`            Payload: ${JSON.stringify(payload)}`);
    console.log(`            Message ID: ${messageId}`);
    receivedMessages.push({ from, payload, messageId });
  };
  console.log('   ✓ Agent B created with onMessage handler\n');

  // Connect both agents
  console.log('3. Connecting both agents...');
  try {
    await agentA.connect();
    console.log('   ✓ Agent A connected');
    await agentB.connect();
    console.log('   ✓ Agent B connected\n');
  } catch (error) {
    console.error('   ✗ Connection failed:', error.message);
    process.exit(1);
  }

  // Give a moment for connection to stabilize
  await new Promise(r => setTimeout(r, 200));

  // Send a message from A to B
  // The message body can be any JSON-serializable value
  console.log('4. Sending message from Agent A to Agent B...');
  const testMessage = 'Hello from Agent A!';

  const sent = agentA.sendMessage('AgentB', testMessage);
  if (sent) {
    console.log('   ✓ Message sent\n');
  } else {
    console.error('   ✗ sendMessage returned false (client not ready?)');
    process.exit(1);
  }

  // Wait for message to be received
  console.log('5. Waiting for message delivery...');
  await new Promise(r => setTimeout(r, 1500));

  // Verify message was received
  console.log('\n6. Verifying message receipt...');
  if (receivedMessages.length === 0) {
    console.error('   ✗ No messages received!');
    console.error('   Debug: Check relay daemon logs for routing info');
    process.exit(1);
  }

  const received = receivedMessages[0];
  // payload.body contains our message
  if (received.from === 'AgentA' && received.payload.body === testMessage) {
    console.log('   ✓ Message received correctly!');
    console.log(`   ✓ From: ${received.from}`);
    console.log(`   ✓ Body: ${received.payload.body}`);
  } else {
    console.error('   ✗ Message content mismatch!');
    console.error(`   Expected from: AgentA, got: ${received.from}`);
    console.error(`   Expected body: ${testMessage}, got: ${received.payload.body}`);
    process.exit(1);
  }

  // Send a reply from B to A
  console.log('\n7. Testing reply: Agent B → Agent A...');

  agentB.sendMessage('AgentA', 'Hello back from Agent B!');
  await new Promise(r => setTimeout(r, 1500));

  if (replyReceived) {
    console.log('   ✓ Reply received successfully!\n');
  } else {
    console.error('   ✗ Reply not received!');
    process.exit(1);
  }

  // Cleanup
  console.log('8. Disconnecting agents...');
  agentA.disconnect();
  agentB.disconnect();
  console.log('   ✓ Done\n');

  console.log('=== Test 02 PASSED ===');
  process.exit(0);
}

main();
