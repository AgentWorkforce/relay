/**
 * Test 05b2: Orchestrator sends message TO worker
 *
 * Reverse direction test to isolate the issue.
 */

import { RelayClient } from '@agent-relay/sdk';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 05b2: Orchestrator → Worker ===\n');

  const runId = Date.now().toString(36);
  const orchName = `Orch-${runId}`;
  const workerName = `Worker-${runId}`;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchName,
    socketPath,
    quiet: false,
  });
  await orchestrator.connect();
  console.log('   ✓ Connected\n');

  // Step 2: Spawn worker that logs received messages
  console.log('2. Spawning worker...');
  const workerScript = resolve(__dirname, 'worker.js');

  const proc = spawn('node', [workerScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AGENT_RELAY_NAME: workerName,
      ORCHESTRATOR: orchName,
      TASK_ID: 'receive-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', d => console.log(`   ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));

  console.log(`   ✓ Worker spawned (PID: ${proc.pid})\n`);

  // Step 3: Wait for worker to connect
  console.log('3. Waiting for worker to connect...');
  await new Promise(r => setTimeout(r, 3000));

  const agents = await orchestrator.listAgents();
  const workerConnected = agents.find(a => a.name === workerName);
  if (workerConnected) {
    console.log('   ✓ Worker is connected\n');
  } else {
    console.log('   ✗ Worker not found\n');
    proc.kill();
    orchestrator.disconnect();
    process.exit(1);
  }

  // Step 4: Send message from orchestrator to worker
  console.log('4. Sending message from orchestrator to worker...');
  const testMsg = { type: 'ping', data: 'Hello from orchestrator!' };
  const sent = orchestrator.sendMessage(workerName, testMsg);
  console.log(`   sendMessage returned: ${sent}`);
  console.log('   Waiting 5s for worker to receive...\n');

  await new Promise(r => setTimeout(r, 5000));

  // Cleanup
  console.log('\n5. Cleaning up...');
  proc.kill();
  orchestrator.disconnect();
  console.log('   ✓ Done\n');

  console.log('=== Test 05b2 COMPLETE (check worker logs above) ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
