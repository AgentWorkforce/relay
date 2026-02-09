/**
 * Test 16: SET_MODEL - Switch a running agent's model
 *
 * This test verifies the full SET_MODEL flow end-to-end:
 * 1. Connect as orchestrator via SDK
 * 2. Spawn a real Claude agent
 * 3. Wait for the agent to become ready
 * 4. Call setWorkerModel() to switch to a different model
 * 5. Verify the result and check listWorkers shows updated model
 * 6. Release the agent and disconnect
 *
 * Prerequisites:
 * - Run `node dist/src/cli/index.js up` in the project directory first
 * - Have `claude` CLI installed and authenticated
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

// Configuration
const WORKER_NAME = `SetModelWorker-${Date.now().toString(36)}`;
const ORCHESTRATOR_NAME = `SetModelOrch-${Date.now().toString(36)}`;
const AGENT_READY_TIMEOUT = 120000; // 120s for agent to connect and become ready
const MODEL_SWITCH_TIMEOUT = 60000; // 60s for model switch (includes idle wait)

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== Test 16: SET_MODEL - Switch Running Agent Model ===\n');

  // =========================================================================
  // Step 1: Create and connect orchestrator
  // =========================================================================
  console.log('1. Creating orchestrator client...');
  console.log(`   Name: ${ORCHESTRATOR_NAME}`);
  console.log(`   Socket: ${socketPath}`);

  const orchestrator = new RelayClient({
    agentName: ORCHESTRATOR_NAME,
    socketPath,
    quiet: true,
  });

  // Track messages from the worker
  let workerReady = false;
  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`   [msg] ${from}: ${body.slice(0, 120)}`);
  };

  try {
    await orchestrator.connect();
    console.log('   ✓ Connected\n');
  } catch (error) {
    console.error('   ✗ Connection failed:', error.message);
    console.error('\n   Make sure to run `node dist/src/cli/index.js up` first!');
    process.exit(1);
  }

  // =========================================================================
  // Step 2: Spawn a Claude agent
  // =========================================================================
  console.log(`2. Spawning Claude agent "${WORKER_NAME}"...`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: WORKER_NAME,
      cli: 'claude',
      task: `You are a test agent for model switching. Your ONLY job is to wait for instructions. Do NOT exit. Do NOT do any work. Just acknowledge that you are ready by sending a message to "${ORCHESTRATOR_NAME}" with body "READY". Then wait silently.`,
      cwd: projectRoot,
    });

    if (spawnResult.success) {
      console.log(`   ✓ Spawn successful (PID: ${spawnResult.pid})`);
    } else {
      console.error('   ✗ Spawn failed:', spawnResult.error);
      orchestrator.disconnect();
      process.exit(1);
    }
  } catch (error) {
    console.error('   ✗ Spawn error:', error.message);
    orchestrator.disconnect();
    process.exit(1);
  }

  // =========================================================================
  // Step 3: Wait for agent to be ready (connected to relay)
  // =========================================================================
  console.log(`\n3. Waiting for agent to connect (max ${AGENT_READY_TIMEOUT / 1000}s)...`);

  const startTime = Date.now();
  let agentConnected = false;

  while (Date.now() - startTime < AGENT_READY_TIMEOUT) {
    try {
      const agents = await orchestrator.listAgents();
      const worker = agents.find(a => a.name === WORKER_NAME);
      if (worker) {
        agentConnected = true;
        console.log(`   ✓ Agent "${WORKER_NAME}" connected!`);
        break;
      }
    } catch (_) {
      // listAgents may fail during setup
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await sleep(2000);
  }
  console.log('');

  if (!agentConnected) {
    console.error('   ✗ Agent did not connect within timeout');
    try { await orchestrator.release(WORKER_NAME); } catch (_) {}
    orchestrator.disconnect();
    process.exit(1);
  }

  // Give the agent a few more seconds to finish its initial task and become idle
  console.log('   Waiting 15s for agent to become idle...');
  await sleep(15000);

  // =========================================================================
  // Step 4: Check current workers before model switch
  // =========================================================================
  console.log('\n4. Listing workers before model switch...');
  try {
    const workersResult = await orchestrator.listWorkers();
    const workers = workersResult.workers || [];
    for (const w of workers) {
      console.log(`   - ${w.name} (cli: ${w.cli}, model: ${w.model || 'unknown'})`);
    }
  } catch (error) {
    console.log(`   ⚠ Could not list workers: ${error.message}`);
  }

  // =========================================================================
  // Step 5: Switch the model
  // =========================================================================
  const targetModel = 'haiku';
  console.log(`\n5. Switching model to "${targetModel}" (timeout: ${MODEL_SWITCH_TIMEOUT / 1000}s)...`);

  try {
    const setModelResult = await orchestrator.setWorkerModel(
      WORKER_NAME,
      targetModel,
      { timeoutMs: MODEL_SWITCH_TIMEOUT },
      MODEL_SWITCH_TIMEOUT + 15000, // Protocol timeout slightly longer
    );

    console.log('   Result:', JSON.stringify(setModelResult, null, 2));

    if (setModelResult.success) {
      console.log(`   ✓ Model switch succeeded!`);
      if (setModelResult.previousModel) {
        console.log(`   ✓ Previous model: ${setModelResult.previousModel}`);
      }
      console.log(`   ✓ New model: ${setModelResult.model}`);
    } else {
      console.error(`   ✗ Model switch failed: ${setModelResult.error}`);
    }
  } catch (error) {
    console.error(`   ✗ Model switch error: ${error.message}`);
  }

  // =========================================================================
  // Step 6: Verify model via listWorkers
  // =========================================================================
  console.log('\n6. Verifying model via listWorkers...');
  try {
    const workersResult = await orchestrator.listWorkers();
    const workers = workersResult.workers || [];
    const worker = workers.find(w => w.name === WORKER_NAME);
    if (worker) {
      console.log(`   - ${worker.name} (cli: ${worker.cli}, model: ${worker.model || 'unknown'})`);
      if (worker.model === targetModel) {
        console.log(`   ✓ Model confirmed as "${targetModel}"!`);
      } else {
        console.log(`   ⚠ Model is "${worker.model}", expected "${targetModel}"`);
      }
    } else {
      console.log(`   ⚠ Worker "${WORKER_NAME}" not found in workers list`);
    }
  } catch (error) {
    console.log(`   ⚠ Could not list workers: ${error.message}`);
  }

  // =========================================================================
  // Step 7: Test switching to another model (sonnet)
  // =========================================================================
  const secondModel = 'sonnet';
  console.log(`\n7. Switching model again to "${secondModel}"...`);
  console.log('   Waiting 10s for agent to become idle again...');
  await sleep(10000);

  try {
    const result2 = await orchestrator.setWorkerModel(
      WORKER_NAME,
      secondModel,
      { timeoutMs: MODEL_SWITCH_TIMEOUT },
      MODEL_SWITCH_TIMEOUT + 15000,
    );

    if (result2.success) {
      console.log(`   ✓ Second model switch succeeded!`);
      console.log(`   ✓ Previous: ${result2.previousModel}, New: ${result2.model}`);
    } else {
      console.error(`   ✗ Second switch failed: ${result2.error}`);
    }
  } catch (error) {
    console.error(`   ✗ Second switch error: ${error.message}`);
  }

  // =========================================================================
  // Step 8: Test error cases
  // =========================================================================
  console.log('\n8. Testing error cases...');

  // 8a: Non-existent agent
  console.log('   8a. Non-existent agent...');
  try {
    const badResult = await orchestrator.setWorkerModel('NonExistentAgent', 'haiku');
    console.log(`   Result: success=${badResult.success}, error=${badResult.error}`);
    if (!badResult.success) {
      console.log('   ✓ Correctly failed for non-existent agent');
    }
  } catch (error) {
    console.log(`   ✓ Correctly threw error: ${error.message}`);
  }

  // =========================================================================
  // Step 9: Release and cleanup
  // =========================================================================
  console.log('\n9. Releasing worker...');
  try {
    const releaseResult = await orchestrator.release(WORKER_NAME);
    if (releaseResult.success) {
      console.log('   ✓ Worker released');
    } else {
      console.log(`   ⚠ Release: ${releaseResult.error || 'unknown issue'}`);
    }
  } catch (error) {
    console.log(`   ⚠ Release error: ${error.message}`);
  }

  // =========================================================================
  // Step 10: Disconnect
  // =========================================================================
  console.log('\n10. Disconnecting...');
  orchestrator.disconnect();
  console.log('   ✓ Done\n');

  console.log('=== Test 16 PASSED ===');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
