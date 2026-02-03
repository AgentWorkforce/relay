/**
 * Test 13: MCP Budget Negotiation Demo
 *
 * This test verifies (MCP parity with SDK test 09):
 * - Multi-agent negotiation using real CLI agents via MCP
 * - 3 teams (Frontend, Backend, Infra) negotiate $100K budget allocation
 * - Full transcript output with voting results
 *
 * Usage:
 *   node tests/mcp/13-mcp-negotiation.js [cli]
 *
 *   cli: 'claude' (default), 'codex', or 'gemini'
 *
 * Prerequisites:
 * - Run `agent-relay up` in the project directory first
 * - Have the specified CLI installed and authenticated
 */

import { RelayClient } from '@agent-relay/sdk';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
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

class TranscriptLogger {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.transcripts = new Map();
    this.globalLog = [];

    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
  }

  log(agent, direction, message) {
    const entry = {
      timestamp: new Date().toISOString(),
      agent,
      direction,
      message: typeof message === 'string' ? message : JSON.stringify(message),
    };

    if (!this.transcripts.has(agent)) {
      this.transcripts.set(agent, []);
    }
    this.transcripts.get(agent).push(entry);
    this.globalLog.push(entry);

    const time = entry.timestamp.split('T')[1].split('.')[0];
    const preview = entry.message.substring(0, 80);
    console.log(`[${time}] [${agent}] ${direction}: ${preview}${entry.message.length > 80 ? '...' : ''}`);
  }

  save() {
    // Save individual agent transcripts
    for (const [agent, messages] of this.transcripts) {
      const filename = resolve(this.outputDir, `${agent.toLowerCase().replace(/[^a-z0-9]/g, '-')}.txt`);
      const content = messages.map(m =>
        `[${m.timestamp}]\n${m.direction}: ${m.message}\n`
      ).join('\n---\n\n');
      writeFileSync(filename, content);
    }

    // Save global transcript
    const globalFilename = resolve(this.outputDir, 'full-transcript.txt');
    const globalContent = this.globalLog.map(m =>
      `[${m.timestamp}] [${m.agent}]\n${m.direction}: ${m.message}\n`
    ).join('\n---\n\n');
    writeFileSync(globalFilename, globalContent);

    console.log(`\nTranscripts saved to: ${this.outputDir}`);
  }
}

async function main() {
  console.log(`=== Test 13: MCP Budget Negotiation Demo (CLI: ${CLI.toUpperCase()}) ===\n`);
  console.log('Scenario: 3 teams negotiate $100K budget allocation via MCP\n');
  console.log('Teams: Frontend, Backend, Infra\n');

  const runId = Date.now().toString(36);
  const coordinatorName = `Coordinator-${runId}`;
  const outputDir = resolve(projectRoot, 'transcripts', `mcp-negotiation-${runId}`);
  const logger = new TranscriptLogger(outputDir);

  const agents = [
    {
      id: 'frontend',
      name: `Frontend-${runId}`,
      role: 'Frontend Team Lead',
      priorities: 'Design System ($25K), Accessibility ($20K), Performance ($15K), Mobile ($10K)',
      keyArg: 'ADA compliance deadline in Q3',
      minViable: 35000,
    },
    {
      id: 'backend',
      name: `Backend-${runId}`,
      role: 'Backend Team Lead',
      priorities: 'Microservices ($30K), Caching ($15K), API Gateway ($10K), Dev Tools ($5K)',
      keyArg: 'Last outage cost $50K in lost revenue',
      minViable: 40000,
    },
    {
      id: 'infra',
      name: `Infra-${runId}`,
      role: 'Infrastructure Team Lead',
      priorities: 'Kubernetes ($25K), Multi-Region ($20K), Observability ($10K), CI/CD ($5K)',
      keyArg: 'EU data residency compliance requirement',
      minViable: 35000,
    },
  ];

  const readyAgents = new Set();
  const responses = new Map();
  const votes = new Map();
  const spawnedAgents = [];

  // Step 1: Connect coordinator
  console.log('1. Connecting coordinator...');
  const coordinator = new RelayClient({
    agentName: coordinatorName,
    socketPath,
    quiet: true,
  });

  coordinator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);

    logger.log(from, 'SAID', body);
    responses.set(from, body);

    // Check for vote pattern
    const voteMatch = body.match(/I VOTE:\s*Frontend=\$?([\d,]+),?\s*Backend=\$?([\d,]+),?\s*Infra=\$?([\d,]+)/i);
    if (voteMatch) {
      const vote = {
        frontend: parseInt(voteMatch[1].replace(/,/g, '')),
        backend: parseInt(voteMatch[2].replace(/,/g, '')),
        infra: parseInt(voteMatch[3].replace(/,/g, '')),
      };
      votes.set(from, vote);
      console.log(`   [VOTE DETECTED] ${from}: Frontend=$${vote.frontend}, Backend=$${vote.backend}, Infra=$${vote.infra}`);
    }
  };

  await coordinator.connect();
  console.log(`   Coordinator: ${coordinatorName}`);
  console.log('   Connected\n');

  // Step 2: Spawn team agents via MCP
  console.log('2. Spawning team agents via MCP...');

  for (const agent of agents) {
    const otherTeams = agents.filter(a => a.id !== agent.id).map(a => a.name);

    try {
      const spawnResult = await coordinator.spawn({
        name: agent.name,
        cli: CLI,
        task: `You are the ${agent.role} in a budget negotiation. Your team's priorities are: ${agent.priorities}. Your key argument: "${agent.keyArg}". Your minimum viable budget is $${agent.minViable}.

The total budget is $100,000 to be split between Frontend, Backend, and Infra teams.

Other participants: ${otherTeams.join(', ')}. The coordinator is "${coordinatorName}".

When asked to introduce yourself: State your team's top priority and why it's important.
When asked about synergies/compromises: Identify where your needs align with other teams.
When asked to vote: Propose a final allocation using this EXACT format:
"I VOTE: Frontend=$X, Backend=$Y, Infra=$Z"

Keep responses concise (under 100 words). Always respond to the coordinator.`,
        cwd: projectRoot,
      });

      if (spawnResult.success) {
        console.log(`   Spawned ${agent.name} (${agent.role}) PID: ${spawnResult.pid}`);
        spawnedAgents.push(agent.name);
        readyAgents.add(agent.name);
      } else {
        console.error(`   Failed to spawn ${agent.name}: ${spawnResult.error}`);
      }
    } catch (error) {
      console.error(`   Spawn error for ${agent.name}: ${error.message}`);
    }
  }
  console.log('');

  // Wait for agents to connect
  console.log('3. Waiting for agents to connect (max 45s)...');

  const connectStart = Date.now();
  const connectTimeout = 45000;
  let connectedCount = 0;

  while (Date.now() - connectStart < connectTimeout) {
    const agentList = await coordinator.listAgents();
    connectedCount = agents.filter(a =>
      agentList.some(agent => agent.name === a.name)
    ).length;

    if (connectedCount === agents.length) {
      console.log(`   All ${agents.length} agents connected!`);
      break;
    }

    const elapsed = Math.round((Date.now() - connectStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (${connectedCount}/${agents.length} connected)`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('');

  // Give agents a moment to settle
  await new Promise(r => setTimeout(r, 5000));

  // Step 4: Run negotiation rounds
  console.log('\n' + '='.repeat(60));
  console.log('\n### NEGOTIATION TRANSCRIPT ###\n');

  // Round 1: Introductions
  console.log('--- ROUND 1: Introductions ---\n');
  for (const agent of agents) {
    if (spawnedAgents.includes(agent.name)) {
      const prompt = "Please introduce yourself and state your team's top priority.";
      coordinator.sendMessage(agent.name, prompt);
      logger.log(coordinatorName, `TO ${agent.name}`, prompt);
      await new Promise(r => setTimeout(r, 15000)); // Wait for response
    }
  }

  // Round 2: Discussion
  console.log('\n--- ROUND 2: Discussion ---\n');
  for (const agent of agents) {
    if (spawnedAgents.includes(agent.name)) {
      const prompt = 'What synergies or compromises do you see with other teams?';
      coordinator.sendMessage(agent.name, prompt);
      logger.log(coordinatorName, `TO ${agent.name}`, prompt);
      await new Promise(r => setTimeout(r, 15000)); // Wait for response
    }
  }

  // Round 3: Voting
  console.log('\n--- ROUND 3: Voting ---\n');
  for (const agent of agents) {
    if (spawnedAgents.includes(agent.name)) {
      const prompt = 'Please propose your final budget allocation. State: I VOTE: Frontend=$X, Backend=$Y, Infra=$Z';
      coordinator.sendMessage(agent.name, prompt);
      logger.log(coordinatorName, `TO ${agent.name}`, prompt);
      await new Promise(r => setTimeout(r, 15000)); // Wait for response
    }
  }

  // Additional wait for any stragglers
  await new Promise(r => setTimeout(r, 10000));

  // Results
  console.log('\n' + '='.repeat(60));
  console.log('\n### VOTING RESULTS ###\n');

  if (votes.size > 0) {
    for (const [agent, vote] of votes) {
      const total = vote.frontend + vote.backend + vote.infra;
      console.log(`${agent}:`);
      console.log(`  Frontend: $${vote.frontend.toLocaleString()}`);
      console.log(`  Backend:  $${vote.backend.toLocaleString()}`);
      console.log(`  Infra:    $${vote.infra.toLocaleString()}`);
      console.log(`  Total:    $${total.toLocaleString()}\n`);
    }

    // Calculate average
    const voteArr = [...votes.values()];
    const avgFrontend = Math.round(voteArr.reduce((s, v) => s + v.frontend, 0) / voteArr.length);
    const avgBackend = Math.round(voteArr.reduce((s, v) => s + v.backend, 0) / voteArr.length);
    const avgInfra = Math.round(voteArr.reduce((s, v) => s + v.infra, 0) / voteArr.length);

    console.log('--- CONSENSUS (Average) ---');
    console.log(`  Frontend: $${avgFrontend.toLocaleString()}`);
    console.log(`  Backend:  $${avgBackend.toLocaleString()}`);
    console.log(`  Infra:    $${avgInfra.toLocaleString()}`);
    console.log(`  Total:    $${(avgFrontend + avgBackend + avgInfra).toLocaleString()}`);
  } else {
    console.log('No votes recorded');
    console.log('\nResponses received:');
    for (const [agent, response] of responses) {
      console.log(`  ${agent}: ${response.substring(0, 100)}...`);
    }
  }

  // Cleanup
  console.log('\n4. Cleaning up...');
  for (const agentName of spawnedAgents) {
    try {
      const releaseResult = await coordinator.release(agentName);
      if (releaseResult.success) {
        console.log(`   Released ${agentName}`);
      } else {
        console.log(`   ${agentName}: ${releaseResult.error || 'already exited'}`);
      }
    } catch (error) {
      console.log(`   ${agentName} release error: ${error.message}`);
    }
  }

  logger.save();
  coordinator.disconnect();

  console.log(`\n=== Test 13 (MCP/${CLI.toUpperCase()}) COMPLETE ===`);
  console.log(`\nFull transcript: ${resolve(outputDir, 'full-transcript.txt')}`);

  // Determine success - at least some responses received
  const success = responses.size >= 1;

  if (success) {
    console.log(`\n=== Test 13 (MCP/${CLI.toUpperCase()}) PASSED ===`);
    process.exit(0);
  } else {
    console.log(`\n=== Test 13 (MCP/${CLI.toUpperCase()}) FAILED ===`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
