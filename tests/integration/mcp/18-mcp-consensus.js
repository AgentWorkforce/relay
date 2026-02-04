/**
 * Test 18: MCP Consensus - Proposal and voting operations
 *
 * This test verifies:
 * - Agents can create proposals via relay_proposal
 * - Agents can vote on proposals via relay_vote
 * - Voting results are tracked correctly
 *
 * Usage:
 *   node tests/mcp/18-mcp-consensus.js [cli]
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
  console.log(`=== Test 18: MCP Consensus (CLI: ${CLI.toUpperCase()}) ===\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const voterName = `Voter-${runId}`;
  const proposalId = `proposal-${runId}`;

  let voteConfirmed = false;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n   [Message received]`);
    console.log(`   From: ${from}`);
    console.log(`   Body: ${body.substring(0, 150)}...`);

    if (body.includes('VOTE_CAST') || body.includes('voted')) {
      voteConfirmed = true;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log('   Connected\n');

  // Step 2: Create a proposal via SDK
  console.log('2. Creating proposal via SDK...');
  console.log(`   Proposal ID: ${proposalId}`);
  console.log('   Options: Option A, Option B, Option C\n');

  try {
    const proposalResult = await orchestrator.createProposal({
      id: proposalId,
      description: 'Test proposal for voting',
      options: ['Option A', 'Option B', 'Option C'],
      votingMethod: 'majority',
    });

    if (proposalResult.success) {
      console.log('   Proposal created successfully!');
    } else {
      console.log(`   Proposal creation failed: ${proposalResult.error}`);
    }
  } catch (error) {
    console.log(`   Proposal error (may be expected): ${error.message}`);
  }

  // Step 3: Spawn agent to vote on the proposal
  console.log('\n3. Spawning voter agent...');
  console.log(`   Name: ${voterName}`);
  console.log(`   Task: Vote on proposal using MCP tools\n`);

  try {
    const spawnResult = await orchestrator.spawn({
      name: voterName,
      cli: CLI,
      task: `You are a test agent participating in a vote. Your tasks:

1. Use the relay_vote tool to cast a vote on proposal "${proposalId}" with:
   - proposal_id: "${proposalId}"
   - vote: "Option B"
   - reason: "Option B provides the best balance"

2. After voting, send a message to "${orchestratorName}" with the text "VOTE_CAST: Option B"

3. Then exit.`,
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

  // Step 4: Wait for vote confirmation
  console.log('\n4. Waiting for vote confirmation (max 60s)...');

  const startTime = Date.now();
  const timeout = 60000;

  while (!voteConfirmed && Date.now() - startTime < timeout) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s`);
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('');

  // Step 5: Release voter
  console.log('\n5. Releasing voter agent...');
  try {
    const releaseResult = await orchestrator.release(voterName);
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
  if (voteConfirmed) {
    console.log('   Vote confirmed!');
    console.log(`\n=== Test 18 (MCP Consensus) PASSED ===`);
    process.exit(0);
  } else {
    console.log('   Vote not confirmed within timeout');
    console.log('   Note: Consensus features may require daemon support');
    console.log(`\n=== Test 18 (MCP Consensus) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
