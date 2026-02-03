/**
 * Test 06: MCP Connect - Spawn Agent and Verify Connection
 *
 * This test verifies:
 * - Spawning an agent via SDK spawn()
 * - The spawned agent connects to the relay via MCP
 * - The agent appears in the listAgents() response
 *
 * Usage:
 *   node tests/mcp/06-mcp-connect.js [cli]
 *
 *   cli: 'claude' (default), 'codex', or 'gemini'
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

// Get CLI from command line args (default: claude)
const CLI = process.argv[2] || 'claude';
const VALID_CLIS = ['claude', 'codex', 'gemini'];

if (!VALID_CLIS.includes(CLI)) {
  console.error(`Invalid CLI: ${CLI}. Must be one of: ${VALID_CLIS.join(', ')}`);
  process.exit(1);
}

async function main() {
  console.log(`=== Test 06: MCP Connect (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const workerName = `MCPWorker-${runId}`;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Spawn agent via MCP
  console.log(`2. Spawning ${CLI} agent via SDK spawn()...`);
  console.log(`   Name: ${workerName}`);
  console.log(`   CLI: ${CLI}`);
  console.log('   Task: Connect and wait for instructions\n');

  try {
    const spawnResult = await orchestrator.spawn({
      name: workerName,
      cli: CLI,
      task: 'You are a test agent. Simply acknowledge you are connected by sending a message to the orchestrator. Send a message with body "CONNECTED" to the agent named "' + orchestratorName + '". Then wait.',
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

  // Step 3: Wait for ${CLI} agent to connect and verify
  console.log('\n3. Waiting for ${CLI} agent to connect (max 30s)...');

  let connected = false;
  const startTime = Date.now();
  const timeout = 30000;

  while (Date.now() - startTime < timeout) {
    const agents = await orchestrator.listAgents();
    const worker = agents.find(a => a.name === workerName);

    if (worker) {
      console.log(`\n   ${CLI} agent "${workerName}" connected!`);
      console.log(`   CLI: ${worker.cli || 'unknown'}`);
      connected = true;
      break;
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!connected) {
    console.log('\n   Timeout: ${CLI} agent did not appear in agent list');
  }

  // Step 4: List all connected agents
  console.log('\n4. Listing all connected agents...');
  const agents = await orchestrator.listAgents();
  for (const agent of agents) {
    console.log(`   - ${agent.name} (cli: ${agent.cli || 'sdk'})`);
  }

  // Step 5: Release the ${CLI} agent
  console.log('\n5. Releasing ${CLI} agent...');
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

  if (connected) {
    console.log(`=== Test 06 (MCP/${CLI.toUpperCase()}) PASSED ===`);
    process.exit(0);
  } else {
    console.log(`=== Test 06 (MCP/${CLI.toUpperCase()}) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
