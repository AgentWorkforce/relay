/**
 * Test 06: Multiple Workers Communication
 *
 * Test multiple SDK workers sending messages to each other via orchestrator.
 */

import { RelayClient } from '@agent-relay/sdk';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

// Worker subprocess mode
if (process.env.I_AM_WORKER) {
  const workerName = process.env.WORKER_NAME;
  const orchName = process.env.ORCH_NAME;
  const workerIndex = process.env.WORKER_INDEX;

  const client = new RelayClient({
    agentName: workerName,
    socketPath,
    quiet: true,
  });

  const receivedMessages = [];

  client.onMessage = (from, payload) => {
    console.log(`[${workerName}] Received from ${from}: ${JSON.stringify(payload.body)}`);
    receivedMessages.push({ from, body: payload.body });

    // Respond to pings
    if (payload.body?.type === 'ping') {
      client.sendMessage(from, { type: 'pong', from: workerName, index: workerIndex });
    }
  };

  client.connect().then(async () => {
    console.log(`[${workerName}] Connected`);

    // Wait for connection to stabilize
    await new Promise(r => setTimeout(r, 500));

    // Announce to orchestrator
    client.sendMessage(orchName, { type: 'ready', worker: workerName, index: workerIndex });

    // Stay alive
    setTimeout(() => {
      console.log(`[${workerName}] Exiting. Received ${receivedMessages.length} messages.`);
      client.disconnect();
      process.exit(0);
    }, 20000);
  });

} else {
  // Main test process
  async function main() {
    console.log('=== Test 06: Multiple Workers Communication ===\n');

    const runId = Date.now().toString(36);
    const orchName = `Orch-${runId}`;
    const workerNames = [`Worker1-${runId}`, `Worker2-${runId}`, `Worker3-${runId}`];

    const readyWorkers = new Set();
    const pongResponses = new Map();

    // Step 1: Connect orchestrator
    console.log('1. Connecting orchestrator...');
    const orchestrator = new RelayClient({
      agentName: orchName,
      socketPath,
      quiet: true,
    });

    orchestrator.onMessage = (from, payload) => {
      const body = payload.body;
      if (body?.type === 'ready') {
        console.log(`   [ORCH] Worker ready: ${body.worker}`);
        readyWorkers.add(body.worker);
      } else if (body?.type === 'pong') {
        console.log(`   [ORCH] Pong from ${body.from} (index ${body.index})`);
        pongResponses.set(body.from, body);
      }
    };

    await orchestrator.connect();
    console.log('   ✓ Connected\n');

    // Step 2: Spawn workers
    console.log('2. Spawning 3 workers...');
    const procs = [];
    const thisFile = fileURLToPath(import.meta.url);

    for (let i = 0; i < 3; i++) {
      const proc = spawn('node', [thisFile], {
        cwd: projectRoot,
        env: {
          ...process.env,
          I_AM_WORKER: '1',
          WORKER_NAME: workerNames[i],
          ORCH_NAME: orchName,
          WORKER_INDEX: String(i + 1),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', d => console.log(`   ${d.toString().trim()}`));
      proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));

      procs.push(proc);
      console.log(`   ✓ ${workerNames[i]} spawned (PID: ${proc.pid})`);
    }
    console.log('');

    // Step 3: Wait for all workers to be ready
    console.log('3. Waiting for workers to be ready...');
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (readyWorkers.size === 3) break;
    }

    if (readyWorkers.size === 3) {
      console.log('   ✓ All 3 workers ready\n');
    } else {
      console.log(`   ✗ Only ${readyWorkers.size}/3 workers ready\n`);
      procs.forEach(p => p.kill());
      orchestrator.disconnect();
      process.exit(1);
    }

    // Step 4: Send ping to each worker
    console.log('4. Sending ping to each worker...');
    for (const workerName of workerNames) {
      const sent = orchestrator.sendMessage(workerName, { type: 'ping', from: orchName });
      console.log(`   Ping to ${workerName}: ${sent ? '✓' : '✗'}`);
    }
    console.log('');

    // Step 5: Wait for pong responses
    console.log('5. Waiting for pong responses...');
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (pongResponses.size === 3) break;
    }

    if (pongResponses.size === 3) {
      console.log('   ✓ All 3 workers responded with pong\n');
    } else {
      console.log(`   ✗ Only ${pongResponses.size}/3 pong responses\n`);
    }

    // Step 6: Verify agent list
    console.log('6. Verifying agent list...');
    const agents = await orchestrator.listAgents();
    const connectedWorkers = workerNames.filter(name =>
      agents.some(a => a.name === name)
    );
    console.log(`   Connected workers: ${connectedWorkers.length}/3\n`);

    // Cleanup
    console.log('7. Cleaning up...');
    procs.forEach(p => p.kill());
    orchestrator.disconnect();
    console.log('   ✓ Done\n');

    const success = readyWorkers.size === 3 && pongResponses.size === 3;
    if (success) {
      console.log('=== Test 06 PASSED ===');
      process.exit(0);
    } else {
      console.log('=== Test 06 FAILED ===');
      process.exit(1);
    }
  }

  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
