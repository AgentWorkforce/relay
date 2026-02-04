/**
 * Test 05b1: Message Stability
 *
 * Test if connections stay stable after sending a message.
 */

import { RelayClient } from '@agent-relay/sdk';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

// If we're the worker subprocess
if (process.env.I_AM_WORKER) {
  const workerName = process.env.WORKER_NAME;
  const orchName = process.env.ORCH_NAME;

  const client = new RelayClient({
    agentName: workerName,
    socketPath,
    quiet: false,
  });

  client.onStateChange = (state) => {
    console.log(`[WORKER] State: ${state}`);
  };

  client.onMessage = (from, payload) => {
    console.log(`[WORKER] Got message from ${from}: ${JSON.stringify(payload.body)}`);
  };

  client.connect().then(async () => {
    console.log('[WORKER] Connected');

    // Wait a bit for connection to stabilize
    await new Promise(r => setTimeout(r, 1000));

    // Send a message
    console.log(`[WORKER] Sending message to ${orchName}...`);
    const sent = client.sendMessage(orchName, { type: 'hello', from: workerName });
    console.log(`[WORKER] sendMessage returned: ${sent}`);

    // Stay alive to see if connection drops
    console.log('[WORKER] Staying alive for 10s to monitor connection...');
    setTimeout(() => {
      console.log('[WORKER] Time up, disconnecting');
      client.disconnect();
      process.exit(0);
    }, 10000);

  }).catch(err => {
    console.error('[WORKER] Connect error:', err.message);
    process.exit(1);
  });

} else {
  // Main test process
  async function main() {
    console.log('=== Test 05b1: Message Stability ===\n');

    const runId = Date.now().toString(36);
    const orchName = `Orch-${runId}`;
    const workerName = `Worker-${runId}`;

    let messageReceived = false;

    console.log('1. Connecting orchestrator...');
    const orchestrator = new RelayClient({
      agentName: orchName,
      socketPath,
      quiet: false,
    });

    orchestrator.onStateChange = (state) => {
      console.log(`[ORCH] State: ${state}`);
    };

    orchestrator.onMessage = (from, payload) => {
      console.log(`\n[ORCH] *** MESSAGE RECEIVED ***`);
      console.log(`[ORCH] From: ${from}`);
      console.log(`[ORCH] Body: ${JSON.stringify(payload.body)}\n`);
      messageReceived = true;
    };

    await orchestrator.connect();
    console.log('   ✓ Connected\n');

    console.log('2. Spawning worker subprocess...');
    const thisFile = fileURLToPath(import.meta.url);
    const proc = spawn('node', [thisFile], {
      cwd: projectRoot,
      env: {
        ...process.env,
        I_AM_WORKER: '1',
        WORKER_NAME: workerName,
        ORCH_NAME: orchName,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', d => console.log(`   ${d.toString().trim()}`));
    proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));
    proc.on('exit', code => console.log(`   [Worker exited: ${code}]`));

    console.log(`   PID: ${proc.pid}\n`);

    console.log('3. Monitoring for 15 seconds...');
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const agents = await orchestrator.listAgents();
      const hasWorker = agents.some(a => a.name === workerName);
      const status = hasWorker ? 'connected' : 'DISCONNECTED';
      const msgStatus = messageReceived ? '✓ msg received' : 'waiting...';
      console.log(`   [${i+1}s] Worker: ${status}, ${msgStatus}`);
    }

    console.log('\n4. Result:');
    if (messageReceived) {
      console.log('   ✓ Message was received by orchestrator!');
    } else {
      console.log('   ✗ No message received');
    }

    console.log('\n5. Cleanup...');
    proc.kill();
    orchestrator.disconnect();
    console.log('   Done\n');

    if (messageReceived) {
      console.log('=== Test 05b1 PASSED ===');
      process.exit(0);
    } else {
      console.log('=== Test 05b1 FAILED ===');
      process.exit(1);
    }
  }

  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
