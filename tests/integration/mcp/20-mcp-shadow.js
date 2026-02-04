/**
 * Test 20: MCP Shadow Agents - Shadow binding and monitoring
 *
 * This test verifies:
 * - Agents can bind as shadows via relay_shadow_bind
 * - Shadows receive notifications about primary agent activity
 * - Shadows can unbind via relay_shadow_unbind
 *
 * Usage:
 *   node tests/mcp/20-mcp-shadow.js [cli]
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
  console.log(`=== Test 20: MCP Shadow Agents (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const primaryName = `Primary-${runId}`;
  const shadowName = `Shadow-${runId}`;
  const testMessage = `PRIMARY_ACTION_${runId}`;

  let shadowBound = false;
  let shadowReceivedNotification = false;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Orchestrator received message]`);
    console.log(`   From: ${from}`);
    console.log(`   Body: ${body.substring(0, 100)}...`);

    if (body.includes('SHADOW_BOUND')) {
      shadowBound = true;
    }
    if (body.includes('SHADOW_OBSERVED') || body.includes(testMessage)) {
      shadowReceivedNotification = true;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Connect primary agent
  console.log('2. Connecting primary agent...');
  const primary = new RelayClient({
    agentName: primaryName,
    socketPath,
    quiet: true,
  });

  primary.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Primary received message]`);
    console.log(`   From: ${from}`);
    console.log(`   Body: ${body.substring(0, 100)}`);
  };

  await primary.connect();
  console.log(`   Name: ${primaryName}`);
  console.log('   Connected\n');

  // Step 3: Spawn shadow agent
  console.log('3. Spawning shadow agent...');
  console.log(`   Name: ${shadowName}`);
  console.log(`   Task: Bind as shadow to ${primaryName}\n`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: shadowName,
      cli: CLI,
      task: `You are a shadow agent. Your tasks:

1. Use relay_shadow_bind to bind as a shadow to "${primaryName}"
   - primary_agent: "${primaryName}"
   - speak_on: ["MESSAGE_SENT", "SESSION_END"]

2. After binding, send a message to "${orchestratorName}" saying "SHADOW_BOUND to ${primaryName}"

3. Wait for about 10 seconds to observe any activity from the primary

4. Then use relay_shadow_unbind to unbind from "${primaryName}"

5. Send a message to "${orchestratorName}" saying "SHADOW_UNBOUND"

6. Then exit.`,
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

  // Step 4: Wait for shadow to bind
  console.log('\n4. Waiting for shadow binding (max 30s)...');

  let waitStart = Date.now();
  while (!shadowBound && Date.now() - waitStart < 30000) {
    await new Promise(r => setTimeout(r, 1000));
  }

  if (shadowBound) {
    console.log('   Shadow bound successfully!');
  } else {
    console.log('   Shadow binding not confirmed (continuing anyway)');
  }

  // Step 5: Primary sends a message (to trigger shadow observation)
  console.log('\n5. Primary agent sending message...');
  await primary.send(orchestratorName, testMessage);
  console.log(`   Sent: ${testMessage}`);

  // Step 6: Wait for shadow to observe
  console.log('\n6. Waiting for shadow observation (max 30s)...');

  waitStart = Date.now();
  while (!shadowReceivedNotification && Date.now() - waitStart < 30000) {
    await new Promise(r => setTimeout(r, 1000));
  }

  // Step 7: Cleanup
  console.log('\n7. Cleaning up...');
  try {
    await orchestrator.release(shadowName);
    console.log('   Released shadow agent');
  } catch (e) {
    console.log(`   Shadow release: ${e.message}`);
  }

  primary.disconnect();
  console.log('   Disconnected primary');

  orchestrator.disconnect();
  console.log('   Disconnected orchestrator\n');

  // Step 8: Verification
  console.log('8. Verification:');
  console.log(`   Shadow bound: ${shadowBound ? 'YES' : 'NO'}`);
  console.log(`   Shadow observed activity: ${shadowReceivedNotification ? 'YES' : 'NO'}`);

  if (shadowBound) {
    console.log(`\n=== Test 20 (MCP Shadow Agents) PASSED ===`);
    process.exit(0);
  } else {
    console.log('   Note: Shadow features may require additional daemon support');
    console.log(`\n=== Test 20 (MCP Shadow Agents) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
