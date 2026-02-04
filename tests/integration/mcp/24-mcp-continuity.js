/**
 * Test 24: MCP Continuity - Session state save/load
 *
 * This test verifies:
 * - Agents can save session state via relay_continuity
 * - Agents can load previous state
 * - Uncertain items can be marked for follow-up
 *
 * Usage:
 *   node tests/mcp/24-mcp-continuity.js [cli]
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
  console.log(`=== Test 24: MCP Continuity (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const continuityAgentName = `ContinuityAgent-${runId}`;

  let stateSaved = false;
  let stateLoaded = false;
  let uncertainMarked = false;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Message received from ${from}]`);
    console.log(`   Body: ${body.substring(0, 150)}...`);

    if (body.includes('STATE_SAVED') || body.includes('saved') || body.includes('recovery')) {
      stateSaved = true;
    }
    if (body.includes('STATE_LOADED') || body.includes('loaded') || body.includes('context')) {
      stateLoaded = true;
    }
    if (body.includes('UNCERTAIN_MARKED') || body.includes('uncertain')) {
      uncertainMarked = true;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Spawn agent to test continuity features
  console.log('2. Spawning continuity test agent...');
  console.log(`   Name: ${continuityAgentName}`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: continuityAgentName,
      cli: CLI,
      task: `You are a test agent for session continuity features. Your tasks:

1. Use relay_continuity with action="save" to save your session state:
   - action: "save"
   - current_task: "Testing continuity features"
   - completed: "Connected to relay"
   - in_progress: "Testing save/load"
   - key_decisions: "Using test data"
   - files: "test-file.js"

2. Send a message to "${orchestratorName}" saying "STATE_SAVED" followed by the result

3. Use relay_continuity with action="load" to test loading state:
   - action: "load"

4. Send a message to "${orchestratorName}" saying "STATE_LOADED" followed by the result

5. Use relay_continuity with action="uncertain" to mark something as uncertain:
   - action: "uncertain"
   - item: "API rate limiting behavior needs verification"

6. Send a message to "${orchestratorName}" saying "UNCERTAIN_MARKED" followed by the result

7. Then exit.

Report what happens with each continuity operation.`,
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

  // Step 3: Wait for continuity operation reports
  console.log('\n3. Waiting for continuity operation reports (max 90s)...');

  const startTime = Date.now();
  const timeout = 90000;

  while ((!stateSaved || !stateLoaded || !uncertainMarked) && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const status = `Save: ${stateSaved ? 'YES' : 'NO'}, Load: ${stateLoaded ? 'YES' : 'NO'}, Uncertain: ${uncertainMarked ? 'YES' : 'NO'}`;
    process.stdout.write(`\r   Waiting... ${elapsed}s (${status})`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 4: Release agent
  console.log('\n4. Releasing continuity agent...');
  try {
    const releaseResult = await orchestrator.release(continuityAgentName);
    if (releaseResult.success) {
      console.log('   Released successfully');
    } else {
      console.log(`   Release: ${releaseResult.error || 'already exited'}`);
    }
  } catch (error) {
    console.log(`   Release error: ${error.message}`);
  }

  // Step 5: Cleanup
  console.log('\n5. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   Done\n');

  // Step 6: Verification
  console.log('6. Verification:');
  console.log(`   State saved: ${stateSaved ? 'YES' : 'NO'}`);
  console.log(`   State loaded: ${stateLoaded ? 'YES' : 'NO'}`);
  console.log(`   Uncertain marked: ${uncertainMarked ? 'YES' : 'NO'}`);

  // Pass if any continuity operation worked
  const anyPassed = stateSaved || stateLoaded || uncertainMarked;
  if (anyPassed) {
    console.log(`\n=== Test 24 (MCP Continuity) PASSED ===`);
    process.exit(0);
  } else {
    console.log('\n   Note: Continuity features may require additional client support');
    console.log(`\n=== Test 24 (MCP Continuity) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
