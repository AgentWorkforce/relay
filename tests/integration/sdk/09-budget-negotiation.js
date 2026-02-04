/**
 * Test 09: Budget Negotiation Demo
 *
 * Multi-agent negotiation where 3 teams (Frontend, Backend, Infra) negotiate
 * a $100K budget allocation. Each agent advocates for their priorities and
 * must reach consensus through voting.
 */

import { RelayClient } from '@agent-relay/sdk';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

// Agent configurations
const AGENTS = {
  frontend: {
    name: 'Frontend-Team',
    cli: 'claude',
    priorities: 'Design System ($25K), Accessibility ($20K), Performance ($15K), Mobile ($15K)',
    keyArgument: 'Accessibility is legal compliance (ADA deadline Q3)',
    minimumViable: '$35K',
  },
  backend: {
    name: 'Backend-Team',
    cli: 'claude',
    priorities: 'Microservices ($30K), Caching ($15K), API Gateway ($12K), Dev Tools ($8K)',
    keyArgument: 'Last outage cost $50K - need resilience',
    minimumViable: '$40K',
  },
  infra: {
    name: 'Infra-Team',
    cli: 'claude',
    priorities: 'Kubernetes ($25K), Multi-Region ($20K), Observability ($18K), CI/CD ($12K)',
    keyArgument: 'EU data residency is compliance requirement',
    minimumViable: '$35K',
  },
};

const SCENARIO = `## Scenario
Your startup has **$100,000** to allocate across three teams for Q2.
Total requests exceed budget - you must negotiate and reach consensus.

## Constraints
- Total budget: $100,000
- Minimum per team: $15,000
- Maximum per team: $50,000

## Communication Rules
- Keep messages concise (under 100 words)
- Listen to other teams and find synergies
- When ready to vote, state: "I VOTE: Frontend=$X, Backend=$Y, Infra=$Z"
- Need 2/3 majority to pass`;

function createAgentTask(agentConfig, allAgentNames, coordinatorName) {
  return `You are the ${agentConfig.name} representative in a budget negotiation.

${SCENARIO}

## Your Team
- Priorities: ${agentConfig.priorities}
- Key argument: ${agentConfig.keyArgument}
- Minimum viable: ${agentConfig.minimumViable}

## Other Teams
${Object.values(AGENTS).filter(a => a.name !== agentConfig.name).map(a =>
  `- ${a.name}: ${a.priorities.split(',')[0]} (argues: ${a.keyArgument})`
).join('\n')}

## Your Task
1. Introduce yourself and your top priority
2. Respond to messages from other teams
3. Propose compromises when appropriate
4. Vote when you think consensus is possible

When you receive a message, respond with your thoughts. Be collaborative but advocate for your team.
Start by introducing yourself and stating your most critical need.

IMPORTANT: When the coordinator asks you to respond, send your message back to them. Keep responses brief (1-3 sentences).`;
}

class TranscriptLogger {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.transcripts = new Map(); // agent -> messages[]
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

    console.log(`[${entry.timestamp.split('T')[1].split('.')[0]}] [${agent}] ${direction}: ${entry.message.substring(0, 100)}${entry.message.length > 100 ? '...' : ''}`);
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
    const globalContent = this.globalLog.map(m =>
      `[${m.timestamp}] [${m.agent}] ${m.direction}: ${m.message}`
    ).join('\n\n');
    writeFileSync(globalFilename, globalContent);

    console.log(`\nTranscripts saved to: ${this.outputDir}`);
  }
}

async function main() {
  console.log('=== Test 09: Budget Negotiation Demo ===\n');
  console.log('Scenario: 3 teams negotiate $100K budget allocation\n');

  const runId = Date.now().toString(36);
  const coordinatorName = `Coordinator-${runId}`;
  const outputDir = resolve(projectRoot, 'transcripts', `negotiation-${runId}`);
  const logger = new TranscriptLogger(outputDir);

  const spawnedAgents = [];
  const votes = new Map();
  let roundNumber = 0;
  const maxRounds = 5;

  // Prepare agent names
  const agentConfigs = Object.entries(AGENTS).map(([key, config]) => ({
    ...config,
    id: key,
    fullName: `${config.name}-${runId}`,
  }));

  const allAgentNames = agentConfigs.map(a => a.fullName);

  // Step 1: Connect coordinator
  console.log('1. Connecting coordinator...');
  const coordinator = new RelayClient({
    agentName: coordinatorName,
    socketPath,
    quiet: true,
  });

  coordinator.onMessage = (from, payload) => {
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
      console.log(`\n   *** VOTE RECORDED from ${from}: Frontend=$${vote.frontend}K, Backend=$${vote.backend}K, Infra=$${vote.infra}K ***\n`);
    }
  };

  await coordinator.connect();
  console.log('   ✓ Connected\n');

  // Step 2: Spawn agents
  console.log('2. Spawning team agents...');
  for (const config of agentConfigs) {
    const task = createAgentTask(config, allAgentNames, coordinatorName);

    try {
      console.log(`   Spawning ${config.fullName}...`);
      const result = await coordinator.spawn({
        name: config.fullName,
        cli: config.cli,
        task: task,
        orchestrator: coordinatorName,
      });
      console.log(`   ✓ ${config.fullName} spawned (PID: ${result.pid})`);
      spawnedAgents.push(config.fullName);
      logger.log(config.fullName, 'SPAWNED', `Task: ${task.substring(0, 200)}...`);
    } catch (err) {
      console.log(`   ✗ Failed to spawn ${config.fullName}: ${err.message}`);
    }
  }
  console.log('');

  // Wait for agents to initialize
  console.log('3. Waiting for agents to initialize...');
  await new Promise(r => setTimeout(r, 8000));

  // Check connected agents
  const agents = await coordinator.listAgents();
  const connectedCount = spawnedAgents.filter(name =>
    agents.some(a => a.name === name)
  ).length;
  console.log(`   Connected: ${connectedCount}/${spawnedAgents.length}\n`);

  // Step 3: Facilitate discussion rounds
  console.log('4. Starting negotiation rounds...\n');
  console.log('=' .repeat(60));

  // Round 1: Introductions
  roundNumber++;
  console.log(`\n--- Round ${roundNumber}: Introductions ---\n`);
  for (const agentName of spawnedAgents) {
    const prompt = 'Please introduce yourself and state your top priority in 2-3 sentences.';
    coordinator.sendMessage(agentName, prompt);
    logger.log(coordinatorName, 'TO ' + agentName, prompt);
    await new Promise(r => setTimeout(r, 12000)); // Wait for response
  }

  // Round 2: Discussion
  roundNumber++;
  console.log(`\n--- Round ${roundNumber}: Discussion ---\n`);
  for (const agentName of spawnedAgents) {
    const prompt = 'Based on what you heard from other teams, what synergies or compromises do you see? Respond in 2-3 sentences.';
    coordinator.sendMessage(agentName, prompt);
    logger.log(coordinatorName, 'TO ' + agentName, prompt);
    await new Promise(r => setTimeout(r, 12000));
  }

  // Round 3: Proposals
  roundNumber++;
  console.log(`\n--- Round ${roundNumber}: Proposals ---\n`);
  for (const agentName of spawnedAgents) {
    const prompt = 'Propose a budget allocation that you think is fair. State: "I VOTE: Frontend=$X, Backend=$Y, Infra=$Z" where X+Y+Z=100000';
    coordinator.sendMessage(agentName, prompt);
    logger.log(coordinatorName, 'TO ' + agentName, prompt);
    await new Promise(r => setTimeout(r, 15000));
  }

  // Check for consensus
  console.log('\n' + '='.repeat(60));
  console.log('\n5. Vote Summary:\n');

  if (votes.size > 0) {
    for (const [agent, vote] of votes) {
      console.log(`   ${agent}: Frontend=$${vote.frontend}K, Backend=$${vote.backend}K, Infra=$${vote.infra}K`);
    }

    // Check if votes are similar (within $5K for each category)
    if (votes.size >= 2) {
      const voteArr = [...votes.values()];
      const avgFrontend = voteArr.reduce((s, v) => s + v.frontend, 0) / voteArr.length;
      const avgBackend = voteArr.reduce((s, v) => s + v.backend, 0) / voteArr.length;
      const avgInfra = voteArr.reduce((s, v) => s + v.infra, 0) / voteArr.length;

      console.log(`\n   Average: Frontend=$${Math.round(avgFrontend)}K, Backend=$${Math.round(avgBackend)}K, Infra=$${Math.round(avgInfra)}K`);
    }
  } else {
    console.log('   No votes recorded');
  }

  // Cleanup
  console.log('\n6. Releasing agents...');
  for (const name of spawnedAgents) {
    try {
      await coordinator.release(name);
      console.log(`   ✓ Released ${name}`);
    } catch (err) {
      console.log(`   ✗ Failed to release ${name}: ${err.message}`);
    }
  }

  // Save transcripts
  logger.save();

  coordinator.disconnect();
  console.log('\n   ✓ Demo complete\n');

  console.log('=== Test 09 COMPLETE ===');
  console.log(`\nView full transcript: ${resolve(outputDir, 'full-transcript.txt')}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
