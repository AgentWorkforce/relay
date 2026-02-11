/**
 * Live (non-scripted) SET_MODEL test.
 * Run with: node tests/integration/sdk/live-set-model.mjs
 * Requires: local daemon running via `node dist/src/cli/index.js up --no-spawn`
 */
import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

const client = new RelayClient({ agentName: 'LiveTest', socketPath, quiet: true });

client.onMessage = (from, payload) => {
  const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
  console.log(`  [msg from ${from}]: ${body.slice(0, 150)}`);
};

await client.connect();
console.log('✓ Connected to daemon\n');

// Spawn
console.log('Spawning ModelTestWorker...');
const spawn = await client.spawn({
  name: 'ModelTestWorker',
  cli: 'claude',
  task: 'You are a test worker. Wait for instructions. Do not exit. Send a message to LiveTest saying READY.',
  cwd: projectRoot,
});
console.log(`  Spawn: success=${spawn.success}, pid=${spawn.pid}\n`);

// Wait for agent to connect
console.log('Waiting for agent to connect...');
for (let i = 0; i < 60; i++) {
  const agents = await client.listAgents();
  if (agents.find(a => a.name === 'ModelTestWorker')) {
    console.log('  ✓ Worker connected!\n');
    break;
  }
  await new Promise(r => setTimeout(r, 2000));
  process.stdout.write('.');
}

// Wait for idle
console.log('Waiting 20s for worker to become idle...');
await new Promise(r => setTimeout(r, 20000));

// Show current state
const w1 = await client.listWorkers();
const worker1 = w1.workers?.find(w => w.name === 'ModelTestWorker');
console.log(`\nCurrent model: ${worker1?.model || 'unknown'}`);

// Switch to haiku
console.log('\n--- Switching to haiku ---');
const r1 = await client.setWorkerModel('ModelTestWorker', 'haiku', { timeoutMs: 60000 }, 75000);
console.log(`  success: ${r1.success}`);
console.log(`  previousModel: ${r1.previousModel}`);
console.log(`  model: ${r1.model}`);
if (r1.error) console.log(`  error: ${r1.error}`);

// Verify
const w2 = await client.listWorkers();
const worker2 = w2.workers?.find(w => w.name === 'ModelTestWorker');
console.log(`  listWorkers model: ${worker2?.model}`);

// Wait for idle again
console.log('\nWaiting 10s...');
await new Promise(r => setTimeout(r, 10000));

// Switch to sonnet
console.log('\n--- Switching to sonnet ---');
const r2 = await client.setWorkerModel('ModelTestWorker', 'sonnet', { timeoutMs: 60000 }, 75000);
console.log(`  success: ${r2.success}`);
console.log(`  previousModel: ${r2.previousModel}`);
console.log(`  model: ${r2.model}`);

// Verify
const w3 = await client.listWorkers();
const worker3 = w3.workers?.find(w => w.name === 'ModelTestWorker');
console.log(`  listWorkers model: ${worker3?.model}`);

// Wait then switch back to opus
console.log('\nWaiting 10s...');
await new Promise(r => setTimeout(r, 10000));

console.log('\n--- Switching to opus ---');
const r3 = await client.setWorkerModel('ModelTestWorker', 'opus', { timeoutMs: 60000 }, 75000);
console.log(`  success: ${r3.success}`);
console.log(`  previousModel: ${r3.previousModel}`);
console.log(`  model: ${r3.model}`);

// Final verify
const w4 = await client.listWorkers();
const worker4 = w4.workers?.find(w => w.name === 'ModelTestWorker');
console.log(`  listWorkers model: ${worker4?.model}`);

// Error case: bad agent
console.log('\n--- Error case: non-existent agent ---');
const r4 = await client.setWorkerModel('FakeAgent', 'haiku');
console.log(`  success: ${r4.success}, error: ${r4.error}`);

// Release
console.log('\nReleasing worker...');
const rel = await client.release('ModelTestWorker');
console.log(`  Released: ${rel.success}`);

client.disconnect();
console.log('\n✓ Done!');
process.exit(0);
