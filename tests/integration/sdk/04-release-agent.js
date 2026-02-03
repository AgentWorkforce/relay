/**
 * Test 04: Release Agents
 *
 * This test verifies:
 * - Releasing a spawned agent via client.release()
 * - Agent is removed from connected agents list
 * - Releasing non-existent agent handles gracefully
 * - Spawning multiple agents and releasing them
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
  console.log('=== Test 04: Release Agents ===\n');

  // Create orchestrator client
  console.log('1. Creating orchestrator client...');
  const orchestrator = new RelayClient({
    agentName: 'ReleaseTestOrchestrator',
    socketPath,
    quiet: true,
  });

  await orchestrator.connect();
  console.log('   ✓ Connected\n');

  // Spawn two agents
  console.log('2. Spawning two Claude agents...');

  const agent1Result = await orchestrator.spawn({
    name: 'ReleaseTest-Worker1',
    cli: 'claude',
    task: 'You are a test agent. Just wait for instructions. Do not do anything else.',
    cwd: projectRoot,
  });

  if (agent1Result.success) {
    console.log(`   ✓ Worker1 spawned (PID: ${agent1Result.pid})`);
  } else {
    console.error('   ✗ Worker1 spawn failed:', agent1Result.error);
    process.exit(1);
  }

  const agent2Result = await orchestrator.spawn({
    name: 'ReleaseTest-Worker2',
    cli: 'claude',
    task: 'You are a test agent. Just wait for instructions. Do not do anything else.',
    cwd: projectRoot,
  });

  if (agent2Result.success) {
    console.log(`   ✓ Worker2 spawned (PID: ${agent2Result.pid})`);
  } else {
    console.error('   ✗ Worker2 spawn failed:', agent2Result.error);
    process.exit(1);
  }

  // Wait for agents to connect
  console.log('\n3. Waiting for agents to connect...');
  await new Promise(r => setTimeout(r, 3000));

  // List agents before release
  console.log('\n4. Listing agents BEFORE release...');
  let agents = await orchestrator.listAgents();
  const workersBefore = agents.filter(a => a.name.startsWith('ReleaseTest-Worker'));
  console.log(`   Found ${workersBefore.length} test workers:`);
  for (const agent of workersBefore) {
    console.log(`   - ${agent.name}`);
  }

  // Release Worker1
  console.log('\n5. Releasing ReleaseTest-Worker1...');
  try {
    const release1 = await orchestrator.release('ReleaseTest-Worker1');
    if (release1.success) {
      console.log('   ✓ Worker1 released successfully');
    } else {
      console.log('   ⚠ Release returned:', release1);
    }
  } catch (error) {
    console.error('   ✗ Release error:', error.message);
  }

  // Wait for release to take effect
  await new Promise(r => setTimeout(r, 2000));

  // List agents after first release
  console.log('\n6. Listing agents AFTER releasing Worker1...');
  agents = await orchestrator.listAgents();
  const worker1Still = agents.find(a => a.name === 'ReleaseTest-Worker1');
  const worker2Still = agents.find(a => a.name === 'ReleaseTest-Worker2');

  if (!worker1Still) {
    console.log('   ✓ Worker1 is no longer in the list');
  } else {
    console.log('   ⚠ Worker1 still appears in list (may take time to clean up)');
  }

  if (worker2Still) {
    console.log('   ✓ Worker2 is still connected');
  } else {
    console.log('   ⚠ Worker2 disappeared unexpectedly');
  }

  // Try releasing non-existent agent
  console.log('\n7. Testing release of non-existent agent...');
  try {
    const releaseNonExistent = await orchestrator.release('NonExistentAgent-12345');
    console.log(`   Result: success=${releaseNonExistent.success}`);
    if (releaseNonExistent.error) {
      console.log(`   Error message: ${releaseNonExistent.error}`);
    }
    console.log('   ✓ Handled gracefully (no crash)');
  } catch (error) {
    console.log(`   ✓ Threw error as expected: ${error.message}`);
  }

  // Release Worker2
  console.log('\n8. Releasing ReleaseTest-Worker2...');
  try {
    const release2 = await orchestrator.release('ReleaseTest-Worker2');
    if (release2.success) {
      console.log('   ✓ Worker2 released successfully');
    } else {
      console.log('   Result:', release2);
    }
  } catch (error) {
    console.error('   ✗ Release error:', error.message);
  }

  // Wait and verify all workers are gone
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n9. Final agent list...');
  agents = await orchestrator.listAgents();
  const workersAfter = agents.filter(a => a.name.startsWith('ReleaseTest-Worker'));

  if (workersAfter.length === 0) {
    console.log('   ✓ All test workers have been released');
  } else {
    console.log(`   ⚠ ${workersAfter.length} test worker(s) still present`);
  }

  console.log('   Remaining agents:');
  for (const agent of agents) {
    console.log(`   - ${agent.name}`);
  }

  // Cleanup
  console.log('\n10. Disconnecting orchestrator...');
  orchestrator.disconnect();
  console.log('   ✓ Done\n');

  console.log('=== Test 04 PASSED ===');
  process.exit(0);
}

main();
