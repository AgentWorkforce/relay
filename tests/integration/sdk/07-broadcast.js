/**
 * Test 07: Broadcast Messages
 *
 * Test broadcast messaging where one agent sends to all others.
 * This simulates a chat room scenario like the budget negotiation.
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
  const allWorkers = JSON.parse(process.env.ALL_WORKERS || '[]');
  const orchName = process.env.ORCH_NAME;

  const client = new RelayClient({
    agentName: workerName,
    socketPath,
    quiet: true,
  });

  const receivedMessages = [];

  client.onMessage = (from, payload) => {
    const body = payload.body;
    console.log(`[${workerName}] From ${from}: ${body.text || JSON.stringify(body)}`);
    receivedMessages.push({ from, body });

    // If it's a broadcast from another worker, acknowledge to orchestrator
    if (body?.type === 'chat' && from !== workerName) {
      client.sendMessage(orchName, {
        type: 'ack',
        worker: workerName,
        receivedFrom: from,
        text: body.text,
      });
    }

    // If orchestrator asks us to broadcast
    if (body?.type === 'please_broadcast') {
      console.log(`[${workerName}] Broadcasting to all workers...`);
      for (const target of allWorkers) {
        if (target !== workerName) {
          client.sendMessage(target, {
            type: 'chat',
            from: workerName,
            text: `Hello from ${workerName}!`,
          });
        }
      }
      client.sendMessage(orchName, { type: 'broadcast_done', worker: workerName });
    }
  };

  client.connect().then(async () => {
    console.log(`[${workerName}] Connected`);
    await new Promise(r => setTimeout(r, 500));
    client.sendMessage(orchName, { type: 'ready', worker: workerName });

    // Stay alive
    setTimeout(() => {
      console.log(`[${workerName}] Exiting. Received ${receivedMessages.length} messages.`);
      client.disconnect();
      process.exit(0);
    }, 30000);
  });

} else {
  // Main test process
  async function main() {
    console.log('=== Test 07: Broadcast Messages ===\n');

    const runId = Date.now().toString(36);
    const orchName = `Orch-${runId}`;
    const workerNames = [`Alice-${runId}`, `Bob-${runId}`, `Charlie-${runId}`];

    const readyWorkers = new Set();
    const acks = [];
    const broadcastsDone = new Set();

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
        readyWorkers.add(body.worker);
      } else if (body?.type === 'ack') {
        console.log(`   [ACK] ${body.worker} received "${body.text}" from ${body.receivedFrom}`);
        acks.push(body);
      } else if (body?.type === 'broadcast_done') {
        broadcastsDone.add(body.worker);
      }
    };

    await orchestrator.connect();
    console.log('   ✓ Connected\n');

    // Step 2: Spawn workers
    console.log('2. Spawning workers (Alice, Bob, Charlie)...');
    const procs = [];
    const thisFile = fileURLToPath(import.meta.url);

    for (const workerName of workerNames) {
      const proc = spawn('node', [thisFile], {
        cwd: projectRoot,
        env: {
          ...process.env,
          I_AM_WORKER: '1',
          WORKER_NAME: workerName,
          ORCH_NAME: orchName,
          ALL_WORKERS: JSON.stringify(workerNames),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', d => console.log(`   ${d.toString().trim()}`));
      proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));

      procs.push(proc);
    }
    console.log('   ✓ All spawned\n');

    // Step 3: Wait for ready
    console.log('3. Waiting for workers to be ready...');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (readyWorkers.size === 3) break;
    }
    console.log(`   ✓ ${readyWorkers.size}/3 ready\n`);

    // Step 4: Tell first worker to broadcast
    console.log('4. Telling Alice to broadcast to everyone...');
    orchestrator.sendMessage(workerNames[0], { type: 'please_broadcast' });

    // Wait for broadcast acknowledgments
    await new Promise(r => setTimeout(r, 2000));
    console.log(`   Acknowledgments received: ${acks.length}\n`);

    // Step 5: Tell all workers to broadcast
    console.log('5. Telling all workers to broadcast...');
    acks.length = 0; // Reset acks
    for (const workerName of workerNames) {
      orchestrator.sendMessage(workerName, { type: 'please_broadcast' });
    }

    // Wait for all broadcasts to complete
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (broadcastsDone.size === 3) break;
    }
    console.log(`   Broadcasts complete: ${broadcastsDone.size}/3`);

    // Wait for acks
    await new Promise(r => setTimeout(r, 2000));

    // Each worker broadcasts to 2 others, so 3 workers * 2 messages = 6 acks expected
    console.log(`   Total acknowledgments: ${acks.length} (expected: 6)\n`);

    // Cleanup
    console.log('6. Cleaning up...');
    procs.forEach(p => p.kill());
    orchestrator.disconnect();
    console.log('   ✓ Done\n');

    const success = acks.length >= 6;
    if (success) {
      console.log('=== Test 07 PASSED ===');
      process.exit(0);
    } else {
      console.log('=== Test 07 FAILED ===');
      process.exit(1);
    }
  }

  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
