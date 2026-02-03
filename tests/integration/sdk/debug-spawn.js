#!/usr/bin/env node
/**
 * Debug spawn test - incrementally test spawning to isolate issues
 */

import { RelayClient } from '@agent-relay/sdk';
import { randomBytes } from 'crypto';
import { join } from 'path';

const CLI = process.argv[2] || 'claude --dangerously-skip-permissions';
const socketPath = join(process.cwd(), '.agent-relay', 'relay.sock');
const NUM_AGENTS = parseInt(process.argv[3] || '1', 10);
const runId = randomBytes(4).toString('hex');

console.log(`\n=== Debug Spawn Test ===`);
console.log(`CLI: ${CLI}`);
console.log(`Agents to spawn: ${NUM_AGENTS}`);
console.log(`Run ID: ${runId}\n`);

async function main() {
  // Connect orchestrator
  const orchestrator = new RelayClient({
    agentName: `TestOrch-${runId}`,
    socketPath,
    quiet: true,
  });

  console.log('1. Connecting orchestrator...');
  await orchestrator.connect();
  console.log('   ✓ Connected\n');

  const agents = [];
  const agentNames = ['UI-Team', 'Backend-Team', 'Infra-Team'];

  // Spawn agents one at a time
  for (let i = 0; i < NUM_AGENTS; i++) {
    const agentName = `${agentNames[i] || 'Agent' + (i + 1)}-${runId}`;
    console.log(`2. Spawning ${agentName}...`);

    const startTime = Date.now();
    // Use negotiation-style task for first agent
    const task = i === 0
      ? `You are the UI-Team representative in a budget negotiation.

## Scenario
Your startup has **$100,000** to allocate across three teams for Q2.
Total requests exceed budget - you must negotiate and reach consensus.

## Your Team
- Priorities: Design System ($25K), Accessibility ($20K), Performance ($15K), Mobile ($15K)
- Key argument: Accessibility is legal compliance - ADA deadline Q3
- Minimum viable: $35K

## Instructions
1. Start by introducing yourself and stating your most critical need
2. Keep all responses to 2-3 sentences
3. Send all responses back to the Orchestrator (TestOrch-${runId})`
      : `You are test agent #${i + 1}. Say hello and introduce yourself.`;

    const result = await orchestrator.spawn({
      name: agentName,
      cli: CLI,
      task,
    });
    const elapsed = Date.now() - startTime;

    console.log(`   Spawn result:`, JSON.stringify(result, null, 2));
    if (result.success) {
      console.log(`   ✓ ${agentName} spawned in ${elapsed}ms (pid: ${result.pid})`);
      agents.push(agentName);
    } else {
      console.log(`   ✗ Failed: ${result.error}`);
    }

    // Wait a bit between spawns
    if (i < NUM_AGENTS - 1) {
      await sleep(2000);
    }
  }

  // Wait for agents to respond
  console.log('\n3. Waiting 20s for agents to respond...\n');

  const messagePromises = [];

  await sleep(10000);

  // Check worker logs
  console.log('\n4. Checking worker logs...');
  const fs = await import('fs');
  const path = await import('path');

  const logsDir = path.join(process.cwd(), '.agent-relay', 'team', 'worker-logs');
  for (const agent of agents) {
    const logFile = path.join(logsDir, `${agent}.log`);
    try {
      const stats = fs.statSync(logFile);
      console.log(`   ${agent}: ${stats.size} bytes`);
    } catch {
      console.log(`   ${agent}: no log file`);
    }
  }

  // Release agents
  console.log('\n5. Releasing agents...');
  for (const agent of agents) {
    const released = await orchestrator.release(agent);
    console.log(`   ${agent}: ${released ? '✓ released' : '✗ failed'}`);
  }

  orchestrator.disconnect();
  console.log('\n=== Test Complete ===\n');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(console.error);
