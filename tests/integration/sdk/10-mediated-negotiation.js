/**
 * Test 10: Mediated Budget Negotiation Demo
 *
 * Multi-agent negotiation with a MEDIATOR that ensures the negotiation
 * reaches a proper conclusion. Uses real Claude agents via agent-relay.
 *
 * CLI: claude (or codex for comparison)
 */

import { RelayClient } from '@agent-relay/sdk';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

// Get CLI from args (default: claude)
const CLI = process.argv[2] || 'claude';
const CLI_FLAGS = CLI === 'claude' ? '--dangerously-skip-permissions' : '';

console.log(`Using CLI: ${CLI} ${CLI_FLAGS}`);

// Agent configurations
const AGENTS = {
  frontend: {
    name: 'UI-Team',
    priorities: 'Design System ($25K), Accessibility ($20K), Performance ($15K), Mobile ($15K)',
    keyArgument: 'Accessibility is legal compliance - ADA deadline Q3',
    minimumViable: '$35K',
  },
  backend: {
    name: 'Backend-Team',
    priorities: 'Microservices ($30K), Caching ($15K), API Gateway ($12K), Dev Tools ($8K)',
    keyArgument: 'Last outage cost $50K in lost revenue - need resilience',
    minimumViable: '$40K',
  },
  infra: {
    name: 'Infra-Team',
    priorities: 'Kubernetes ($25K), Multi-Region ($20K), Observability ($18K), CI/CD ($12K)',
    keyArgument: 'EU data residency is a legal compliance requirement',
    minimumViable: '$35K',
  },
};

const SCENARIO = `## Scenario
Your startup has **$100,000** to allocate across three teams for Q2.
Total requests exceed budget - you must negotiate and reach consensus.

## Constraints
- Total budget: $100,000 (MUST equal exactly this)
- Minimum per team: $15,000
- Maximum per team: $50,000

## Communication Rules
- Keep messages concise (2-3 sentences max)
- Be collaborative and find compromises
- When voting, ALWAYS use format: "I VOTE: Frontend=$X, Backend=$Y, Infra=$Z" (X+Y+Z must = 100000)`;

function createAgentTask(agentConfig, mediatorName) {
  return `You are the ${agentConfig.name} representative in a budget negotiation.

${SCENARIO}

## Your Team
- Priorities: ${agentConfig.priorities}
- Key argument: ${agentConfig.keyArgument}
- Minimum viable: ${agentConfig.minimumViable}

## Instructions
1. Advocate for your team but be willing to compromise
2. When asked to vote, ALWAYS provide a specific allocation that sums to $100,000
3. Keep all responses to 2-3 sentences
4. Send all responses back to the Mediator (${mediatorName})

CRITICAL: When asked to vote, you MUST respond with "I VOTE: Frontend=$X, Backend=$Y, Infra=$Z" where X+Y+Z=100000`;
}

const MEDIATOR_TASK = `You are the MEDIATOR for a budget negotiation between 3 teams.

${SCENARIO}

## Your Role as Mediator
1. Guide the negotiation to reach a FINAL CONSENSUS
2. After all votes are in, CALCULATE the average and DECLARE the final allocation
3. You MUST end the negotiation with a clear "FINAL ALLOCATION" statement

## Teams
- UI-Team: Design/Accessibility focus (ADA compliance deadline)
- Backend-Team: Microservices/Resilience focus (had costly outage)
- Infra-Team: Infrastructure/Compliance focus (EU data residency)

## Process
1. Ask each team to introduce themselves
2. Facilitate discussion
3. Call for votes
4. Calculate average of votes and DECLARE FINAL ALLOCATION

CRITICAL: You MUST conclude with "FINAL ALLOCATION: Frontend=$X, Backend=$Y, Infra=$Z" after votes are tallied.`;

class TranscriptLogger {
  constructor(outputDir, cli) {
    this.outputDir = outputDir;
    this.cli = cli;
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
    const preview = entry.message.substring(0, 120);
    console.log(`[${time}] [${agent}] ${direction}: ${preview}${entry.message.length > 120 ? '...' : ''}`);
  }

  save() {
    // Save individual agent transcripts
    for (const [agent, messages] of this.transcripts) {
      const filename = resolve(this.outputDir, `${agent.toLowerCase().replace(/[^a-z0-9]/g, '-')}.txt`);
      const content = messages.map(m =>
        `[${m.timestamp}] ${m.direction}: ${m.message}`
      ).join('\n\n');
      writeFileSync(filename, content);
    }

    // Save global transcript
    const globalFilename = resolve(this.outputDir, 'full-transcript.txt');
    let globalContent = `# Budget Negotiation Transcript\n`;
    globalContent += `# CLI: ${this.cli}\n`;
    globalContent += `# Date: ${new Date().toISOString()}\n\n`;
    globalContent += this.globalLog.map(m =>
      `[${m.timestamp}] [${m.agent}] ${m.direction}: ${m.message}`
    ).join('\n\n');
    writeFileSync(globalFilename, globalContent);

    // Save prompt file
    const promptFilename = resolve(this.outputDir, 'prompt.md');
    const promptContent = `# Mediated Budget Negotiation Prompt

## CLI Used: ${this.cli}

## Scenario
${SCENARIO}

## Agent Tasks

### Frontend Team
${createAgentTask(AGENTS.frontend, 'Mediator')}

### Backend Team
${createAgentTask(AGENTS.backend, 'Mediator')}

### Infra Team
${createAgentTask(AGENTS.infra, 'Mediator')}

### Mediator
${MEDIATOR_TASK}
`;
    writeFileSync(promptFilename, promptContent);

    console.log(`\nTranscripts saved to: ${this.outputDir}`);
    console.log(`  - full-transcript.txt`);
    console.log(`  - prompt.md`);
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('=== Test 10: Mediated Budget Negotiation ===\n');
  console.log(`CLI: ${CLI}`);
  console.log('Scenario: 3 teams + Mediator negotiate $100K budget\n');

  const runId = Date.now().toString(36);
  const mediatorName = `Mediator-${runId}`;
  const outputDir = resolve(projectRoot, 'transcripts', `negotiation-${CLI}-${runId}`);
  const logger = new TranscriptLogger(outputDir, CLI);

  const spawnedAgents = [];
  const votes = new Map();

  // Prepare agent configs with run ID
  const agentConfigs = Object.entries(AGENTS).map(([key, config]) => ({
    ...config,
    id: key,
    fullName: `${config.name}-${runId}`,
  }));

  // Step 1: Connect orchestrator (us)
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: `Orchestrator-${runId}`,
    socketPath,
    quiet: true,
  });

  const pendingResponses = new Map();

  orchestrator.onMessage = (from, payload) => {
    const body = payload.body;
    const message = typeof body === 'string' ? body : JSON.stringify(body);

    logger.log(from, 'SENT', message);

    // Check for votes
    const voteMatch = message.match(/I VOTE:\s*Frontend=\$?([\d,]+),?\s*Backend=\$?([\d,]+),?\s*Infra=\$?([\d,]+)/i);
    if (voteMatch) {
      const vote = {
        frontend: parseInt(voteMatch[1].replace(/,/g, '')),
        backend: parseInt(voteMatch[2].replace(/,/g, '')),
        infra: parseInt(voteMatch[3].replace(/,/g, '')),
      };
      votes.set(from, vote);
      console.log(`\n   *** VOTE from ${from}: F=$${vote.frontend}, B=$${vote.backend}, I=$${vote.infra} ***\n`);
    }

    // Check for final allocation
    const finalMatch = message.match(/FINAL ALLOCATION:\s*Frontend=\$?([\d,]+),?\s*Backend=\$?([\d,]+),?\s*Infra=\$?([\d,]+)/i);
    if (finalMatch) {
      console.log('\n' + '='.repeat(60));
      console.log('*** FINAL ALLOCATION DECLARED ***');
      console.log(`   Frontend: $${finalMatch[1]}`);
      console.log(`   Backend:  $${finalMatch[2]}`);
      console.log(`   Infra:    $${finalMatch[3]}`);
      console.log('='.repeat(60) + '\n');
    }

    // Resolve pending response
    if (pendingResponses.has(from)) {
      pendingResponses.get(from)(message);
      pendingResponses.delete(from);
    }
  };

  await orchestrator.connect();
  console.log('   ✓ Connected\n');

  // Step 2: Spawn team agents
  console.log('2. Spawning team agents...');
  const orchestratorName = `Orchestrator-${runId}`;
  for (const config of agentConfigs) {
    const task = createAgentTask(config, orchestratorName);
    const cliCmd = CLI_FLAGS ? `${CLI} ${CLI_FLAGS}` : CLI;

    try {
      console.log(`   Spawning ${config.fullName}...`);
      const result = await orchestrator.spawn({
        name: config.fullName,
        cli: cliCmd,
        task: task,
        orchestrator: orchestratorName,  // Critical: tells agent who to reply to
      });
      console.log(`   ✓ ${config.fullName} spawned`);
      spawnedAgents.push(config.fullName);
      logger.log(config.fullName, 'SPAWNED', `Task: ${task.substring(0, 150)}...`);
    } catch (err) {
      console.log(`   ✗ Failed to spawn ${config.fullName}: ${err.message}`);
    }
    await sleep(3000);
  }

  // Wait for agents to initialize
  console.log('\n3. Waiting for agents to initialize...');
  await sleep(10000);

  // Step 3: Run negotiation (orchestrator acts as mediator coordinator)
  console.log('\n' + '='.repeat(60));
  console.log('\n### NEGOTIATION BEGINS ###\n');

  // Round 1: Introductions
  console.log('--- ROUND 1: Introductions ---\n');
  for (const name of spawnedAgents) {
    const prompt = 'Introduce yourself and state your #1 priority in 2 sentences. Reply to me directly.';
    orchestrator.sendMessage(name, prompt);
    logger.log('Mediator', `TO ${name}`, prompt);
    await sleep(20000);
  }

  // Round 2: Discussion
  console.log('\n--- ROUND 2: Finding Common Ground ---\n');
  for (const name of spawnedAgents) {
    const prompt = 'What compromise can you offer? What do you need from other teams? Reply in 2 sentences.';
    orchestrator.sendMessage(name, prompt);
    logger.log('Mediator', `TO ${name}`, prompt);
    await sleep(20000);
  }

  // Round 3: Voting
  console.log('\n--- ROUND 3: Vote on Allocation ---\n');
  for (const name of spawnedAgents) {
    const prompt = 'Submit your final vote NOW. Respond with exactly: "I VOTE: Frontend=$X, Backend=$Y, Infra=$Z" where X+Y+Z=100000';
    orchestrator.sendMessage(name, prompt);
    logger.log('Mediator', `TO ${name}`, prompt);
    await sleep(30000);
  }

  // Wait extra time for late responses
  console.log('\n--- Waiting for late votes (30s) ---\n');
  await sleep(30000);

  // Calculate and declare final allocation
  console.log('\n--- FINAL TALLY ---\n');

  if (votes.size >= 2) {
    const voteArr = [...votes.values()];
    const avgFrontend = Math.round(voteArr.reduce((s, v) => s + v.frontend, 0) / voteArr.length);
    const avgBackend = Math.round(voteArr.reduce((s, v) => s + v.backend, 0) / voteArr.length);
    const avgInfra = Math.round(voteArr.reduce((s, v) => s + v.infra, 0) / voteArr.length);

    // Normalize to exactly $100K
    const total = avgFrontend + avgBackend + avgInfra;
    const adjustment = 100000 - total;
    const finalInfra = avgInfra + adjustment;

    console.log('Votes received:');
    for (const [agent, vote] of votes) {
      console.log(`  ${agent}: F=$${vote.frontend}, B=$${vote.backend}, I=$${vote.infra}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log('*** CONSENSUS REACHED ***');
    console.log(`\nFINAL ALLOCATION: Frontend=$${avgFrontend}, Backend=$${avgBackend}, Infra=$${finalInfra}`);
    console.log(`Total: $${avgFrontend + avgBackend + finalInfra}`);
    console.log('='.repeat(60));

    logger.log('Mediator', 'DECLARED', `FINAL ALLOCATION: Frontend=$${avgFrontend}, Backend=$${avgBackend}, Infra=$${finalInfra}`);
  } else {
    console.log('Not enough votes to reach consensus');
    logger.log('Mediator', 'DECLARED', 'NEGOTIATION FAILED - insufficient votes');
  }

  // Cleanup
  console.log('\n4. Releasing agents...');
  for (const name of spawnedAgents) {
    try {
      await orchestrator.release(name);
      console.log(`   ✓ Released ${name}`);
    } catch (err) {
      console.log(`   ✗ Failed to release ${name}: ${err.message}`);
    }
  }

  // Save transcripts
  logger.save();

  orchestrator.disconnect();
  console.log('\n=== Negotiation Complete ===');
  console.log(`\nTranscript: ${resolve(outputDir, 'full-transcript.txt')}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
