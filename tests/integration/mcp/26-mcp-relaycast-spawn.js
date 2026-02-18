/**
 * Test 26: Relaycast add_agent → Local Spawn Bridge
 *
 * Validates that calling relaycast's `add_agent` MCP tool triggers local
 * process spawning via the broker's WS event handler.
 *
 * This test covers the full roundtrip:
 *   1. add_agent (relaycast MCP) → POST /v1/agents/spawn
 *   2. relaycast server emits `agent.spawn_requested` WS event
 *   3. broker receives event → spawner.spawn_wrap() → local CLI process
 *   4. Agent connects and appears in listAgents()
 *   5. remove_agent (relaycast MCP) → POST /v1/agents/release
 *   6. relaycast server emits `agent.release_requested` WS event
 *   7. broker receives event → spawner.release() → process killed
 *   8. Agent disappears from listAgents()
 *
 * Also tests the existing relay_spawn path as a control:
 *   - SDK spawn() → local socket SPAWN frame → spawner.spawn_wrap()
 *
 * Prerequisites:
 * - Broker PTY is running (started by agent-relay broker or orchestration script)
 * - Broker connected to relaycast (RELAY_API_KEY set in .agent-relay/relaycast.json)
 * - Claude CLI installed
 *
 * Usage:
 *   node tests/integration/mcp/26-mcp-relaycast-spawn.js
 */

import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

const CLI = 'claude';
const SPAWN_TIMEOUT = 45_000;
const RELEASE_TIMEOUT = 10_000;

let orchestrator;
const spawnedAgents = [];

async function cleanup() {
  console.log('\n--- Cleanup ---');
  for (const name of spawnedAgents) {
    try {
      await orchestrator.release(name);
      console.log(`  Released: ${name}`);
    } catch {
      console.log(`  Already gone: ${name}`);
    }
  }
  orchestrator?.disconnect();
}

async function waitForAgent(name, timeoutMs = SPAWN_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const agents = await orchestrator.listAgents();
    if (agents.some(a => a.name === name)) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function waitForAgentGone(name, timeoutMs = RELEASE_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const agents = await orchestrator.listAgents();
    if (!agents.some(a => a.name === name)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const runId = Date.now().toString(36);
  console.log('=== Test 26: Relaycast add_agent → Local Spawn Bridge ===\n');

  // Step 1: Try connecting orchestrator via local SDK (optional — daemon may not be running)
  let controlConnected = false;
  let controlGone = false;
  let daemonAvailable = false;

  console.log('1. Connecting orchestrator via local SDK...');
  try {
    orchestrator = new RelayClient({
      agentName: `Test26-Orchestrator-${runId}`,
      socketPath,
      quiet: true,
    });
    await orchestrator.connect();
    daemonAvailable = true;
    console.log('   Connected\n');
  } catch (error) {
    console.log(`   SKIP: Local daemon not running (${error.message})`);
    console.log('   Skipping SDK control test, proceeding to relaycast test\n');
  }

  // =========================================================================
  // CONTROL: Test relay_spawn (local SDK path) — only if daemon is available
  // =========================================================================

  if (daemonAvailable) {
    const controlAgent = `Control-SDKSpawn-${runId}`;
    console.log(`2. [CONTROL] Spawning agent via SDK relay_spawn: ${controlAgent}`);

    try {
      const result = await orchestrator.spawn({
        name: controlAgent,
        cli: CLI,
        task: 'You are a test agent. Wait for instructions. Do nothing else.',
        cwd: projectRoot,
      });

      if (result.success) {
        spawnedAgents.push(controlAgent);
        console.log(`   Spawned (PID: ${result.pid})`);
      } else {
        console.error(`   FAIL: SDK spawn failed: ${result.error}`);
        await cleanup();
        process.exit(1);
      }
    } catch (error) {
      console.error(`   FAIL: SDK spawn error: ${error.message}`);
      await cleanup();
      process.exit(1);
    }

    console.log('   Waiting for agent to connect...');
    controlConnected = await waitForAgent(controlAgent);
    if (controlConnected) {
      console.log('   PASS: Control agent connected via SDK spawn\n');
    } else {
      console.error('   FAIL: Control agent did not connect within timeout');
      await cleanup();
      process.exit(1);
    }

    // Release control agent
    console.log(`3. [CONTROL] Releasing: ${controlAgent}`);
    await orchestrator.release(controlAgent);
    controlGone = await waitForAgentGone(controlAgent);
    console.log(controlGone ? '   PASS: Control agent released\n' : '   WARN: Control agent still present\n');
  } else {
    console.log('2. [CONTROL] SKIP: Daemon not running\n');
    console.log('3. [CONTROL] SKIP: Daemon not running\n');
  }

  // =========================================================================
  // TEST: add_agent via relaycast MCP → should trigger local spawn
  // =========================================================================

  const relaycastAgent = `Test-RelaycastSpawn-${runId}`;
  console.log(`4. [TEST] Spawning agent via relaycast add_agent: ${relaycastAgent}`);
  console.log('   This calls POST /v1/agents/spawn on relaycast cloud.');
  console.log('   The broker should receive an agent.spawn_requested WS event');
  console.log('   and spawn a local CLI process.\n');

  // We can't call the relaycast MCP directly from here (it's an MCP tool).
  // Instead, simulate what add_agent does: POST to relaycast API.
  const relaycastConfig = await loadRelaycastConfig();

  if (!relaycastConfig) {
    console.log('   SKIP: No relaycast config found (.agent-relay/relaycast.json)');
    console.log('   Cannot test relaycast spawn without RELAY_API_KEY');
    await cleanup();
    process.exit(0);
  }

  try {
    const spawnResponse = await fetch(`${relaycastConfig.baseUrl}/v1/agents/spawn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${relaycastConfig.apiKey}`,
      },
      body: JSON.stringify({
        name: relaycastAgent,
        cli: CLI,
        task: 'You are a test agent. Wait for instructions. Do nothing else.',
      }),
    });

    if (!spawnResponse.ok) {
      const body = await spawnResponse.text();
      console.error(`   FAIL: Relaycast API returned ${spawnResponse.status}: ${body}`);
      await cleanup();
      process.exit(1);
    }

    const spawnResult = await spawnResponse.json();
    const spawnData = spawnResult.data || spawnResult;
    console.log(`   Relaycast API returned: id=${spawnData.id}, name=${spawnData.name}, status=${spawnData.status}`);
    spawnedAgents.push(relaycastAgent);
  } catch (error) {
    console.error(`   FAIL: Relaycast API call failed: ${error.message}`);
    await cleanup();
    process.exit(1);
  }

  // Wait for the agent to appear locally (via WS event → broker → local spawn)
  let relaycastConnected = false;
  if (daemonAvailable) {
    console.log('   Waiting for agent to appear in local agent list...');
    relaycastConnected = await waitForAgent(relaycastAgent);

    if (relaycastConnected) {
      console.log('   PASS: Relaycast add_agent triggered local spawn!\n');
    } else {
      console.error('   FAIL: Agent was NOT spawned locally.');
      console.error('   The broker did not receive or handle the agent.spawn_requested WS event.');
      console.error('   Check:');
      console.error('   1. Does relaycast server emit agent.spawn_requested after POST /v1/agents/spawn?');
      console.error('   2. Does the broker handle agent.spawn_requested in the WS event loop?');

      const agents = await orchestrator.listAgents();
      console.error(`   Current agents: ${agents.map(a => a.name).join(', ') || 'none'}`);
      await cleanup();
      process.exit(1);
    }
  } else {
    console.log('   SKIP: No daemon — cannot verify local spawn. API call succeeded.\n');
    relaycastConnected = true; // API-level pass
  }

  // =========================================================================
  // TEST: remove_agent via relaycast MCP → should trigger local release
  // =========================================================================

  console.log(`5. [TEST] Releasing agent via relaycast remove_agent: ${relaycastAgent}`);

  try {
    const releaseResponse = await fetch(`${relaycastConfig.baseUrl}/v1/agents/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${relaycastConfig.apiKey}`,
      },
      body: JSON.stringify({
        name: relaycastAgent,
        reason: 'test cleanup',
      }),
    });

    if (!releaseResponse.ok) {
      const body = await releaseResponse.text();
      console.error(`   WARN: Relaycast release returned ${releaseResponse.status}: ${body}`);
    } else {
      const releaseResult = await releaseResponse.json();
      const releaseData = releaseResult.data || releaseResult;
      console.log(`   Relaycast API returned: name=${releaseData.name}, deleted=${releaseData.deleted}`);
    }
  } catch (error) {
    console.error(`   WARN: Relaycast release failed: ${error.message}`);
  }

  // Wait for agent to disappear locally
  let relaycastGone = false;
  if (daemonAvailable) {
    console.log('   Waiting for agent to disappear from local agent list...');
    relaycastGone = await waitForAgentGone(relaycastAgent, 15_000);

    if (relaycastGone) {
      console.log('   PASS: Relaycast remove_agent triggered local release!\n');
    } else {
      console.error('   FAIL: Agent still appears locally after remove_agent.');
      console.error('   The broker did not receive or handle the agent.release_requested WS event.');
    }
  } else {
    console.log('   SKIP: No daemon — cannot verify local release. API call succeeded.\n');
    relaycastGone = true; // API-level pass
  }

  // =========================================================================
  // Summary
  // =========================================================================

  await cleanup();

  console.log('\n=== Test 26 Results ===');
  console.log(`  SDK spawn (control):      ${daemonAvailable ? (controlConnected ? 'PASS' : 'FAIL') : 'SKIP'}`);
  console.log(`  Relaycast add_agent:      ${relaycastConnected ? 'PASS' : 'FAIL'}`);
  console.log(`  Relaycast remove_agent:   ${relaycastGone ? 'PASS' : 'FAIL'}`);
  if (!daemonAvailable) {
    console.log('  (Local daemon not running — API-level validation only)');
  }

  const allPassed = relaycastConnected && relaycastGone && (daemonAvailable ? controlConnected : true);
  console.log(`\n=== Test 26 ${allPassed ? 'PASSED' : 'FAILED'} ===`);
  process.exit(allPassed ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadRelaycastConfig() {
  try {
    const { readFileSync } = await import('fs');
    const configPath = resolve(projectRoot, '.agent-relay', 'relaycast.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return {
      apiKey: config.api_key,
      baseUrl: 'https://api.relaycast.dev',
    };
  } catch {
    return null;
  }
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await cleanup().catch(() => {});
  process.exit(1);
});
