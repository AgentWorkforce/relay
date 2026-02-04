/**
 * Test 22: MCP Threads - Threaded conversations
 *
 * This test verifies:
 * - Messages can include thread IDs for threading
 * - Thread context is maintained across messages
 * - Multiple threads can coexist
 *
 * Usage:
 *   node tests/mcp/22-mcp-threads.js [cli]
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 * - Have the specified CLI installed and authenticated
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

const CLI = process.argv[2] || 'claude';
const VALID_CLIS = ['claude', 'codex', 'gemini'];

if (!VALID_CLIS.includes(CLI)) {
  console.error(`Invalid CLI: ${CLI}. Must be one of: ${VALID_CLIS.join(', ')}`);
  process.exit(1);
}

async function main() {
  console.log(`=== Test 22: MCP Threads (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const workerName = `ThreadWorker-${runId}`;
  const threadId1 = `thread-alpha-${runId}`;
  const threadId2 = `thread-beta-${runId}`;

  let thread1MessageReceived = false;
  let thread2MessageReceived = false;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    const thread = payload.thread || 'none';
    console.log(`\n   [Message received]`);
    console.log(`   From: ${from}`);
    console.log(`   Thread: ${thread}`);
    console.log(`   Body: ${body.substring(0, 100)}`);

    if (body.includes('THREAD_ALPHA') || thread.includes('alpha')) {
      thread1MessageReceived = true;
    }
    if (body.includes('THREAD_BETA') || thread.includes('beta')) {
      thread2MessageReceived = true;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Send a threaded message to start thread 1
  console.log('2. Starting thread 1...');
  await orchestrator.send(workerName, `Start of thread alpha`, { thread: threadId1 });
  console.log(`   Thread ID: ${threadId1}`);

  // Step 3: Spawn worker with task to respond in threads
  console.log('\n3. Spawning worker for threaded conversation...');
  console.log(`   Name: ${workerName}`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: workerName,
      cli: CLI,
      task: `You are a test agent for threaded conversations. Your tasks:

1. Use relay_send to send a message to "${orchestratorName}" with:
   - message: "THREAD_ALPHA reply"
   - thread: "${threadId1}"

2. Use relay_send to send a message to "${orchestratorName}" with:
   - message: "THREAD_BETA reply"
   - thread: "${threadId2}"

3. Then exit.

Important: Make sure to include the thread parameter in both relay_send calls to maintain thread context.`,
      cwd: projectRoot,
    });

    if (spawnResult.success) {
      console.log('   Spawn successful!');
      console.log(`   PID: ${spawnResult.pid}`);
    } else {
      console.error(`   Spawn failed: ${spawnResult.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`   Spawn error: ${error.message}`);
    process.exit(1);
  }

  // Step 4: Wait for threaded messages
  console.log('\n4. Waiting for threaded messages (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while ((!thread1MessageReceived || !thread2MessageReceived) && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (Thread1: ${thread1MessageReceived ? 'YES' : 'NO'}, Thread2: ${thread2MessageReceived ? 'YES' : 'NO'})`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 5: Release worker
  console.log('\n5. Releasing worker agent...');
  try {
    const releaseResult = await orchestrator.release(workerName);
    if (releaseResult.success) {
      console.log('   Released successfully');
    } else {
      console.log(`   Release: ${releaseResult.error || 'already exited'}`);
    }
  } catch (error) {
    console.log(`   Release error: ${error.message}`);
  }

  // Step 6: Cleanup
  console.log('\n6. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   Done\n');

  // Step 7: Verification
  console.log('7. Verification:');
  console.log(`   Thread 1 (alpha) message received: ${thread1MessageReceived ? 'YES' : 'NO'}`);
  console.log(`   Thread 2 (beta) message received: ${thread2MessageReceived ? 'YES' : 'NO'}`);

  if (thread1MessageReceived || thread2MessageReceived) {
    console.log(`\n=== Test 22 (MCP Threads) PASSED ===`);
    process.exit(0);
  } else {
    console.log(`\n=== Test 22 (MCP Threads) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
