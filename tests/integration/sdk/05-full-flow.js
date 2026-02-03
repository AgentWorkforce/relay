/**
 * Test 05: Full Orchestration Flow with Real Claude Agents
 *
 * This test demonstrates multi-agent coordination:
 * 1. Orchestrator uses SDK to spawn real Claude agents
 * 2. Claude agents execute tasks and report back via MCP
 * 3. Orchestrator tracks completion and releases agents
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 * - Have `claude` CLI installed and authenticated
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  console.log('=== Test 05: Full Orchestration Flow ===\n');
  console.log('Spawning real Claude agents via SDK spawn().\n');

  // Generate unique run ID
  const runId = Date.now().toString(36);
  const orchestratorName = `Conductor-${runId}`;

  // Track workers
  const workers = new Map();

  // =========================================================================
  // Step 1: Create and connect orchestrator
  // =========================================================================
  console.log('1. Creating orchestrator...');
  console.log(`   Name: ${orchestratorName}`);

  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  // Message handler
  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   📨 [${from}]: ${body.slice(0, 100)}`);

    // Track completion - look for DONE in the message
    if (workers.has(from)) {
      const worker = workers.get(from);
      if (body.includes('DONE') || body.includes('COMPLETE')) {
        worker.status = 'complete';
        worker.result = body;
        console.log(`   ✓ ${from} marked COMPLETE`);
      } else if (body.includes('CRASHED')) {
        worker.status = 'crashed';
        console.log(`   ✗ ${from} CRASHED`);
      }
    }
  };

  await orchestrator.connect();
  console.log('   ✓ Orchestrator connected\n');

  // =========================================================================
  // Step 2: Define worker tasks (simple tasks that will complete quickly)
  // =========================================================================
  console.log('2. Defining workers...');

  const workerDefs = [
    {
      name: `Analyst-${runId}`,
      task: `Send a message to "${orchestratorName}" with body "DONE: Analysis complete". Then exit.`,
    },
    {
      name: `Reporter-${runId}`,
      task: `Send a message to "${orchestratorName}" with body "DONE: Report ready". Then exit.`,
    },
  ];

  for (const def of workerDefs) {
    workers.set(def.name, {
      name: def.name,
      status: 'pending',
      result: null,
      pid: null,
    });
    console.log(`   - ${def.name}`);
  }
  console.log('');

  // =========================================================================
  // Step 3: Spawn workers using SDK spawn()
  // =========================================================================
  console.log('3. Spawning Claude agents via SDK...');

  for (const def of workerDefs) {
    try {
      const result = await orchestrator.spawn({
        name: def.name,
        cli: 'claude',
        task: def.task,
        cwd: projectRoot,
      });

      if (result.success) {
        const worker = workers.get(def.name);
        worker.status = 'running';
        worker.pid = result.pid;
        console.log(`   ✓ ${def.name} spawned (PID: ${result.pid})`);
      } else {
        console.error(`   ✗ ${def.name} failed: ${result.error}`);
        workers.get(def.name).status = 'failed';
      }
    } catch (error) {
      console.error(`   ✗ ${def.name} error: ${error.message}`);
      workers.get(def.name).status = 'failed';
    }
  }
  console.log('');

  // =========================================================================
  // Step 4: Wait for all workers to complete
  // =========================================================================
  console.log('4. Waiting for workers to complete (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while (Date.now() - startTime < timeout) {
    const statuses = Array.from(workers.values()).map(w => w.status);
    const allDone = statuses.every(s => s === 'complete' || s === 'crashed' || s === 'failed');

    if (allDone) {
      console.log('\n   ✓ All workers finished!');
      break;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const summary = Array.from(workers.values())
      .map(w => `${w.name.split('-')[0]}:${w.status}`)
      .join(', ');
    process.stdout.write(`\r   [${elapsed}s] ${summary}        `);

    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('');

  // =========================================================================
  // Step 5: Show results
  // =========================================================================
  console.log('\n5. Worker results:');

  for (const [name, worker] of workers) {
    console.log(`   ${name}:`);
    console.log(`     Status: ${worker.status}`);
    if (worker.result) {
      console.log(`     Result: ${worker.result.slice(0, 60)}...`);
    }
  }

  // =========================================================================
  // Step 6: Release all workers
  // =========================================================================
  console.log('\n6. Releasing workers...');

  for (const [name] of workers) {
    try {
      const result = await orchestrator.release(name);
      if (result.success) {
        console.log(`   ✓ ${name} released`);
      } else {
        console.log(`   - ${name}: ${result.error || 'already exited'}`);
      }
    } catch (error) {
      console.log(`   - ${name}: ${error.message}`);
    }
  }

  // =========================================================================
  // Step 7: Final summary
  // =========================================================================
  console.log('\n7. Final summary:');

  const completed = Array.from(workers.values()).filter(w => w.status === 'complete').length;
  const total = workers.size;

  console.log(`   Workers spawned: ${total}`);
  console.log(`   Workers completed: ${completed}`);
  console.log(`   Success rate: ${Math.round((completed / total) * 100)}%`);

  // Disconnect
  console.log('\n8. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   ✓ Done\n');

  if (completed === total) {
    console.log('=== Test 05 PASSED ===');
    process.exit(0);
  } else if (completed > 0) {
    console.log('=== Test 05 PARTIAL ===');
    process.exit(0);
  } else {
    console.log('=== Test 05 FAILED ===');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
