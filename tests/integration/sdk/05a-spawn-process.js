/**
 * Test 05a: Spawn a single Node.js process that connects via SDK
 *
 * Simplest multi-process test:
 * 1. Orchestrator connects
 * 2. Spawn a worker process
 * 3. Worker connects via SDK
 * 4. Verify both are connected
 */

import { RelayClient } from '@agent-relay/sdk';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 05a: Spawn Single SDK Process ===\n');

  const runId = Date.now().toString(36);

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: `Orch-${runId}`,
    socketPath,
    quiet: true,
  });
  await orchestrator.connect();
  console.log('   ✓ Orchestrator connected\n');

  // Step 2: Spawn worker process
  console.log('2. Spawning worker process...');
  const workerScript = resolve(__dirname, 'worker.js');
  const workerName = `Worker-${runId}`;

  const proc = spawn('node', [workerScript], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AGENT_RELAY_NAME: workerName,
      ORCHESTRATOR: `Orch-${runId}`,
      TASK_ID: 'test-task',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', d => console.log(`   ${d.toString().trim()}`));
  proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));

  console.log(`   ✓ Worker spawned (PID: ${proc.pid})\n`);

  // Step 3: Wait and check agents
  console.log('3. Waiting for worker to connect...');
  await new Promise(r => setTimeout(r, 3000));

  const agents = await orchestrator.listAgents();
  const workerConnected = agents.find(a => a.name === workerName);

  if (workerConnected) {
    console.log(`   ✓ Worker "${workerName}" is connected!`);
  } else {
    console.log(`   ✗ Worker not found in agent list`);
    console.log(`   Agents: ${agents.map(a => a.name).join(', ')}`);
  }

  // Cleanup
  console.log('\n4. Cleaning up...');
  proc.kill();
  orchestrator.disconnect();
  console.log('   ✓ Done\n');

  if (workerConnected) {
    console.log('=== Test 05a PASSED ===');
    process.exit(0);
  } else {
    console.log('=== Test 05a FAILED ===');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
