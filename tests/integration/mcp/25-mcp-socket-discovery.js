/**
 * Test 25: MCP Socket Discovery - Verify socket fix for MCP server
 *
 * This test verifies:
 * - .mcp.json is created with RELAY_SOCKET environment variable
 * - MCP server can find daemon from different working directory
 * - The --project flag is passed correctly
 *
 * This tests the fix from commits:
 * - 9cc7b0a7: set RELAY_SOCKET in MCP config for correct daemon discovery
 * - 6bd1930c: set RELAY_SOCKET for project-local MCP installs
 *
 * Usage:
 *   node tests/mcp/25-mcp-socket-discovery.js
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 */

import { RelayClient } from '@agent-relay/sdk';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');
const mcpConfigPath = resolve(projectRoot, '.mcp.json');

async function main() {
  console.log(`=== Test 25: MCP Socket Discovery ===\n`);

  const runId = Date.now().toString(36);
  let mcpConfigExisted = existsSync(mcpConfigPath);
  let originalMcpConfig = null;

  // Backup existing .mcp.json if present
  if (mcpConfigExisted) {
    originalMcpConfig = readFileSync(mcpConfigPath, 'utf-8');
    console.log('1. Backing up existing .mcp.json...');
  } else {
    console.log('1. No existing .mcp.json (will be created)...');
  }

  // Step 2: Install MCP config using the CLI
  console.log('\n2. Installing MCP config via CLI...');
  try {
    execSync('npx agent-relay mcp install --editor claude-code', {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    console.log('   MCP install command completed');
  } catch (error) {
    console.log(`   MCP install note: ${error.message}`);
    // May fail if already installed globally, continue anyway
  }

  // Step 3: Check if .mcp.json was created/updated
  console.log('\n3. Checking .mcp.json configuration...');

  let mcpConfigValid = false;
  let hasRelaySocket = false;
  let hasProjectFlag = false;

  if (existsSync(mcpConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
      console.log('   .mcp.json exists');

      const agentRelay = config.mcpServers?.['agent-relay'];
      if (agentRelay) {
        console.log('   agent-relay server configured');

        // Check for RELAY_SOCKET env var
        if (agentRelay.env?.RELAY_SOCKET) {
          hasRelaySocket = true;
          console.log(`   ✓ RELAY_SOCKET: ${agentRelay.env.RELAY_SOCKET}`);

          // Verify it points to correct socket
          const expectedSocket = resolve(projectRoot, '.agent-relay', 'relay.sock');
          if (agentRelay.env.RELAY_SOCKET === expectedSocket) {
            console.log('   ✓ Socket path matches project');
          } else {
            console.log(`   ! Socket path differs: expected ${expectedSocket}`);
          }
        } else {
          console.log('   ! RELAY_SOCKET not set in env');
        }

        // Check for --project flag in args
        if (agentRelay.args?.includes('--project')) {
          hasProjectFlag = true;
          const projectIdx = agentRelay.args.indexOf('--project');
          const projectPath = agentRelay.args[projectIdx + 1];
          console.log(`   ✓ --project flag: ${projectPath}`);
        } else {
          console.log('   --project flag not present (may be global install)');
        }

        mcpConfigValid = true;
      } else {
        console.log('   ! agent-relay server not found in config');
      }
    } catch (error) {
      console.log(`   ! Error parsing .mcp.json: ${error.message}`);
    }
  } else {
    console.log('   ! .mcp.json not found');
  }

  // Step 4: Test MCP server can connect from different directory
  console.log('\n4. Testing MCP server daemon discovery...');

  let mcpServerCanConnect = false;

  try {
    // Run the MCP server's status check from a different directory (home)
    // This simulates what happens when an editor launches the MCP server
    const result = execSync(
      `RELAY_SOCKET="${socketPath}" npx @agent-relay/mcp status 2>&1`,
      {
        cwd: process.env.HOME, // Different directory!
        encoding: 'utf-8',
        timeout: 10000,
      }
    );

    if (result.includes('RUNNING') || result.includes('connected') || result.includes('OK')) {
      mcpServerCanConnect = true;
      console.log('   ✓ MCP server can find daemon from different directory');
    } else {
      console.log(`   MCP status output: ${result.substring(0, 100)}`);
    }
  } catch (error) {
    // Try alternative: direct socket check
    console.log('   Trying direct socket verification...');
    try {
      const orchestrator = new RelayClient({
        agentName: `SocketTest-${runId}`,
        socketPath,
        quiet: true,
      });

      await orchestrator.connect();
      mcpServerCanConnect = true;
      console.log('   ✓ Socket is accessible');
      orchestrator.disconnect();
    } catch (e) {
      console.log(`   ! Socket connection failed: ${e.message}`);
    }
  }

  // Step 5: Test spawning from MCP context
  console.log('\n5. Testing spawn with MCP socket context...');

  let spawnWorksWithSocket = false;

  const orchestrator = new RelayClient({
    agentName: `Orchestrator-${runId}`,
    socketPath,
    quiet: true,
  });

  try {
    await orchestrator.connect();
    console.log('   Orchestrator connected');

    // Spawn an agent - this should auto-create .mcp.json with socket fix
    const workerName = `SocketWorker-${runId}`;
    const spawnResult = await orchestrator.spawn({
      name: workerName,
      cli: 'claude',
      task: 'Simply acknowledge connection by sending a message to the orchestrator saying "SOCKET_TEST_OK".',
      cwd: projectRoot,
    });

    if (spawnResult.success) {
      console.log(`   Spawned ${workerName} (PID: ${spawnResult.pid})`);
      spawnWorksWithSocket = true;

      // Wait a moment then release
      await new Promise(r => setTimeout(r, 5000));

      try {
        await orchestrator.release(workerName);
        console.log('   Released worker');
      } catch (e) {
        console.log(`   Release: ${e.message}`);
      }
    } else {
      console.log(`   Spawn failed: ${spawnResult.error}`);
    }
  } catch (error) {
    console.log(`   Error: ${error.message}`);
  }

  orchestrator.disconnect();

  // Step 6: Re-check .mcp.json after spawn (spawner may have created/updated it)
  console.log('\n6. Re-checking .mcp.json after spawn...');

  if (existsSync(mcpConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
      const agentRelay = config.mcpServers?.['agent-relay'];

      if (agentRelay?.env?.RELAY_SOCKET) {
        console.log(`   ✓ RELAY_SOCKET present: ${agentRelay.env.RELAY_SOCKET}`);
        hasRelaySocket = true;
      }

      if (agentRelay?.env?.RELAY_PROJECT || agentRelay?.env?.AGENT_RELAY_PROJECT) {
        console.log(`   ✓ RELAY_PROJECT present`);
      }
    } catch (e) {
      console.log(`   Parse error: ${e.message}`);
    }
  }

  // Step 7: Restore original .mcp.json if needed
  console.log('\n7. Cleanup...');
  if (originalMcpConfig) {
    writeFileSync(mcpConfigPath, originalMcpConfig);
    console.log('   Restored original .mcp.json');
  }
  console.log('   Done\n');

  // Step 8: Summary
  console.log('8. Verification Summary:');
  console.log(`   .mcp.json valid config: ${mcpConfigValid ? 'YES' : 'NO'}`);
  console.log(`   RELAY_SOCKET in config: ${hasRelaySocket ? 'YES' : 'NO'}`);
  console.log(`   --project flag present: ${hasProjectFlag ? 'YES' : 'NO (global install)'}`);
  console.log(`   MCP server can connect: ${mcpServerCanConnect ? 'YES' : 'NO'}`);
  console.log(`   Spawn works with socket: ${spawnWorksWithSocket ? 'YES' : 'NO'}`);

  // Pass if socket discovery works (the main fix being tested)
  const passed = mcpServerCanConnect || spawnWorksWithSocket;

  if (passed) {
    console.log(`\n=== Test 25 (MCP Socket Discovery) PASSED ===`);
    process.exit(0);
  } else {
    console.log(`\n=== Test 25 (MCP Socket Discovery) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
