/**
 * Test 01: Basic SDK Connection
 *
 * This test verifies:
 * - SDK can be imported
 * - RelayClient can be instantiated
 * - Client can connect to the relay daemon
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

// Socket path where relay daemon listens
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 01: Basic SDK Connection ===\n');

  console.log('1. Creating RelayClient...');
  console.log(`   Agent name: TestAgent-01`);
  console.log(`   Socket path: ${socketPath}`);

  const client = new RelayClient({
    agentName: 'TestAgent-01',
    socketPath,
    quiet: false,
  });

  console.log('   ✓ RelayClient created\n');

  console.log('2. Connecting to relay daemon...');

  try {
    await client.connect();
    console.log('   ✓ Connected successfully!\n');

    console.log('3. Client info:');
    console.log(`   Agent name: ${client.agentName}`);
    console.log(`   Connected: true\n`);

    console.log('4. Disconnecting...');
    // Give a moment for any pending operations
    await new Promise(r => setTimeout(r, 500));

    // Clean disconnect
    if (client.disconnect) {
      await client.disconnect();
    }
    console.log('   ✓ Disconnected\n');

    console.log('=== Test 01 PASSED ===');
    process.exit(0);
  } catch (error) {
    console.error('   ✗ Connection failed:', error.message);
    console.error('\n   Make sure to run `agent-relay up` first!');
    console.error('   Socket should exist at:', socketPath);
    process.exit(1);
  }
}

main();
