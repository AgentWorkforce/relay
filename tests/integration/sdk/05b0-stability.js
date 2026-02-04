/**
 * Test 05b0: Connection Stability
 *
 * Minimal test to check if connections stay stable across processes.
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
  const client = new RelayClient({
    agentName: process.env.WORKER_NAME,
    socketPath,
    quiet: false,
  });

  client.onStateChange = (state) => {
    console.log(`[WORKER] State: ${state}`);
  };

  client.onMessage = (from, payload) => {
    console.log(`[WORKER] Got message from ${from}: ${JSON.stringify(payload.body)}`);
  };

  client.connect().then(() => {
    console.log('[WORKER] Connected, staying alive for 10s...');
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
    console.log('=== Test 05b0: Connection Stability ===\n');

    const runId = Date.now().toString(36);
    const orchName = `Orch-${runId}`;
    const workerName = `Worker-${runId}`;

    console.log('1. Connecting orchestrator...');
    const orchestrator = new RelayClient({
      agentName: orchName,
      socketPath,
      quiet: false,
    });

    orchestrator.onStateChange = (state) => {
      console.log(`[ORCH] State: ${state}`);
    };

    await orchestrator.connect();
    console.log('   ✓ Connected\n');

    console.log('2. Spawning worker subprocess...');
    const thisFile = fileURLToPath(import.meta.url);
    const proc = spawn('node', [thisFile], {
      cwd: projectRoot,
      env: { ...process.env, I_AM_WORKER: '1', WORKER_NAME: workerName },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', d => console.log(`   ${d.toString().trim()}`));
    proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));
    proc.on('exit', code => console.log(`   [Worker exited: ${code}]`));

    console.log(`   PID: ${proc.pid}\n`);

    console.log('3. Monitoring for 12 seconds...');
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const agents = await orchestrator.listAgents();
      const hasWorker = agents.some(a => a.name === workerName);
      console.log(`   [${i+1}s] Worker in list: ${hasWorker}`);
    }

    console.log('\n4. Cleanup...');
    proc.kill();
    orchestrator.disconnect();
    console.log('   Done\n');

    console.log('=== Test 05b0 COMPLETE ===');
    process.exit(0);
  }

  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
