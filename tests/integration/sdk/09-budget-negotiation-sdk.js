/**
 * Test 09: Budget Negotiation Demo (SDK Workers)
 *
 * Multi-agent negotiation using SDK workers (Node.js processes).
 * This demonstrates the full transcript output format.
 * Can be switched to real Claude agents once CLI issues are resolved.
 */

import { RelayClient } from '@agent-relay/sdk';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

// Worker subprocess mode
if (process.env.I_AM_WORKER) {
  const workerName = process.env.WORKER_NAME;
  const coordName = process.env.COORD_NAME;
  const role = process.env.ROLE;
  const priorities = process.env.PRIORITIES;
  const keyArg = process.env.KEY_ARG;
  const minViable = process.env.MIN_VIABLE;

  const client = new RelayClient({
    agentName: workerName,
    socketPath,
    quiet: true,
  });

  // Simulated responses based on role
  const responses = {
    intro: () => {
      const intro = {
        frontend: `Hi, I'm the Frontend Team lead. Our top priority is the Design System ($25K) which will accelerate feature development across all teams. We also have a critical ADA compliance deadline in Q3 requiring Accessibility work ($20K).`,
        backend: `Hello, Backend Team here. Our most urgent need is Microservices migration ($30K). Our last outage cost us $50K in lost revenue - we need resilience. Caching ($15K) would also help both frontend performance and our API costs.`,
        infra: `Infra Team checking in. Kubernetes ($25K) and Multi-Region ($20K) are our priorities. EU data residency is a compliance requirement - we could face fines without multi-region by Q3.`,
      };
      return intro[role] || 'Hello from team.';
    },
    discuss: () => {
      const discuss = {
        frontend: `I see synergies with Backend on caching - if they get that, our Performance work becomes cheaper. Infra's observability would help us too. Maybe we can trim Mobile to $10K and fund shared infrastructure?`,
        backend: `Frontend's performance needs align with our caching. If Infra gets Kubernetes, our microservices migration becomes easier. I could reduce Dev Tools ask if others make concessions too.`,
        infra: `Backend's microservices need our Kubernetes. Frontend's performance needs observability. I suggest we each take our top 2 priorities and share the CI/CD costs.`,
      };
      return discuss[role] || 'I see potential compromises.';
    },
    vote: () => {
      const votes = {
        frontend: `After discussion, I propose: I VOTE: Frontend=$35000, Backend=$35000, Infra=$30000. This covers compliance needs for everyone while staying under budget.`,
        backend: `Based on our discussion: I VOTE: Frontend=$30000, Backend=$40000, Infra=$30000. This lets us all hit minimum viable while prioritizing resilience.`,
        infra: `Here's my proposal: I VOTE: Frontend=$33000, Backend=$35000, Infra=$32000. Balanced allocation that covers critical compliance for all teams.`,
      };
      return votes[role] || 'I VOTE: Frontend=$33000, Backend=$34000, Infra=$33000';
    },
  };

  let messageCount = 0;

  client.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`[${workerName}] Received: ${body.substring(0, 50)}...`);

    messageCount++;
    let response;

    // Determine response based on message content or count
    if (body.includes('introduce') || messageCount === 1) {
      response = responses.intro();
    } else if (body.includes('synergies') || body.includes('compromises') || messageCount === 2) {
      response = responses.discuss();
    } else if (body.includes('VOTE') || body.includes('allocation') || messageCount >= 3) {
      response = responses.vote();
    } else {
      response = responses.discuss();
    }

    // Send response back to coordinator
    setTimeout(() => {
      client.sendMessage(coordName, { type: 'response', from: workerName, text: response });
      console.log(`[${workerName}] Sent: ${response.substring(0, 50)}...`);
    }, 500 + Math.random() * 1000);
  };

  client.connect().then(() => {
    console.log(`[${workerName}] Connected as ${role}`);
    client.sendMessage(coordName, { type: 'ready', worker: workerName, role });

    // Stay alive
    setTimeout(() => {
      client.disconnect();
      process.exit(0);
    }, 120000);
  });

} else {
  // Main orchestration process

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
    console.log('=== Test 09: Budget Negotiation Demo ===\n');
    console.log('Scenario: 3 teams negotiate $100K budget allocation\n');
    console.log('Teams: Frontend, Backend, Infra\n');

    const runId = Date.now().toString(36);
    const coordName = `Coordinator-${runId}`;
    const outputDir = resolve(projectRoot, 'transcripts', `negotiation-${runId}`);
    const logger = new TranscriptLogger(outputDir);

    const agents = [
      { id: 'frontend', name: `Frontend-${runId}`, role: 'frontend', priorities: 'Design System, Accessibility, Performance, Mobile', keyArg: 'ADA compliance Q3', minViable: '35000' },
      { id: 'backend', name: `Backend-${runId}`, role: 'backend', priorities: 'Microservices, Caching, API Gateway, Dev Tools', keyArg: 'Last outage cost $50K', minViable: '40000' },
      { id: 'infra', name: `Infra-${runId}`, role: 'infra', priorities: 'Kubernetes, Multi-Region, Observability, CI/CD', keyArg: 'EU data residency', minViable: '35000' },
    ];

    const readyAgents = new Set();
    const responses = new Map();
    const votes = new Map();
    const procs = [];

    // Step 1: Connect coordinator
    console.log('1. Connecting coordinator...');
    const coordinator = new RelayClient({
      agentName: coordName,
      socketPath,
      quiet: true,
    });

    coordinator.onMessage = (from, payload) => {
      const body = payload.body;

      if (body?.type === 'ready') {
        readyAgents.add(body.worker);
        console.log(`   ✓ ${body.worker} (${body.role}) ready`);
        return;
      }

      if (body?.type === 'response') {
        logger.log(from, 'SAID', body.text);
        responses.set(from, body.text);

        // Check for vote
        const voteMatch = body.text.match(/I VOTE:\s*Frontend=\$?([\d,]+),?\s*Backend=\$?([\d,]+),?\s*Infra=\$?([\d,]+)/i);
        if (voteMatch) {
          const vote = {
            frontend: parseInt(voteMatch[1].replace(/,/g, '')),
            backend: parseInt(voteMatch[2].replace(/,/g, '')),
            infra: parseInt(voteMatch[3].replace(/,/g, '')),
          };
          votes.set(from, vote);
        }
      }
    };

    await coordinator.connect();
    console.log('   ✓ Coordinator connected\n');

    // Step 2: Spawn workers
    console.log('2. Spawning team agents...');
    const thisFile = fileURLToPath(import.meta.url);

    for (const agent of agents) {
      const proc = spawn('node', [thisFile], {
        cwd: projectRoot,
        env: {
          ...process.env,
          I_AM_WORKER: '1',
          WORKER_NAME: agent.name,
          COORD_NAME: coordName,
          ROLE: agent.role,
          PRIORITIES: agent.priorities,
          KEY_ARG: agent.keyArg,
          MIN_VIABLE: agent.minViable,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      proc.stdout.on('data', d => {
        const msg = d.toString().trim();
        if (msg) console.log(`   ${msg}`);
      });
      proc.stderr.on('data', d => console.error(`   [ERR] ${d.toString().trim()}`));

      procs.push(proc);
    }
    console.log('');

    // Wait for all agents to be ready
    console.log('3. Waiting for agents to connect...');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      if (readyAgents.size === 3) break;
    }
    console.log(`   ${readyAgents.size}/3 agents ready\n`);

    // Step 3: Run negotiation rounds
    console.log('=' .repeat(60));
    console.log('\n### NEGOTIATION TRANSCRIPT ###\n');

    // Round 1: Introductions
    console.log('--- ROUND 1: Introductions ---\n');
    for (const agent of agents) {
      const prompt = 'Please introduce yourself and state your team\'s top priority.';
      coordinator.sendMessage(agent.name, prompt);
      logger.log(coordName, `TO ${agent.name}`, prompt);
      await new Promise(r => setTimeout(r, 3000));
    }

    // Wait for responses
    await new Promise(r => setTimeout(r, 2000));
    console.log('');

    // Round 2: Discussion
    console.log('--- ROUND 2: Discussion ---\n');
    for (const agent of agents) {
      const prompt = 'What synergies or compromises do you see with other teams?';
      coordinator.sendMessage(agent.name, prompt);
      logger.log(coordName, `TO ${agent.name}`, prompt);
      await new Promise(r => setTimeout(r, 3000));
    }

    await new Promise(r => setTimeout(r, 2000));
    console.log('');

    // Round 3: Voting
    console.log('--- ROUND 3: Voting ---\n');
    for (const agent of agents) {
      const prompt = 'Please propose your final budget allocation. State: I VOTE: Frontend=$X, Backend=$Y, Infra=$Z';
      coordinator.sendMessage(agent.name, prompt);
      logger.log(coordName, `TO ${agent.name}`, prompt);
      await new Promise(r => setTimeout(r, 3000));
    }

    await new Promise(r => setTimeout(r, 2000));

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
    }

    // Cleanup
    console.log('\n4. Cleaning up...');
    procs.forEach(p => p.kill());
    logger.save();
    coordinator.disconnect();

    console.log('\n=== Test 09 COMPLETE ===');
    console.log(`\nFull transcript: ${resolve(outputDir, 'full-transcript.txt')}`);
    process.exit(0);
  }

  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
