/**
 * Test 14: Complex Orchestration Test (SDK)
 *
 * A comprehensive multi-agent orchestration test that verifies:
 * - Task delegation from orchestrator to specialized workers
 * - Inter-agent communication
 * - Results aggregation
 * - Graceful error handling
 *
 * Usage:
 *   node tests/14-orchestration-sdk.js [cli]
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
    this.entries = [];
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
    this.entries.push(entry);
    const time = entry.timestamp.split('T')[1].split('.')[0];
    const preview = entry.message.substring(0, 100);
    console.log(`[${time}] [${agent}] ${direction}: ${preview}${entry.message.length > 100 ? '...' : ''}`);
  }

  save() {
    const filename = resolve(this.outputDir, 'transcript.txt');
    const content = this.entries.map(e =>
      `[${e.timestamp}] [${e.agent}] ${e.direction}:\n${e.message}\n`
    ).join('\n---\n\n');
    writeFileSync(filename, content);
    console.log(`\nTranscript saved to: ${filename}`);
  }
}

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== Test 14: Complex Orchestration (SDK) - CLI: ${CLI.toUpperCase()} ===`);
  console.log(`${'='.repeat(60)}\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `Orchestrator-${runId}`;
  const outputDir = resolve(projectRoot, 'transcripts', `orchestration-sdk-${CLI}-${runId}`);
  const logger = new TranscriptLogger(outputDir);

  // Define specialized workers
  const workers = [
    {
      name: `Researcher-${runId}`,
      role: 'Research Specialist',
      task: `You are a Research Specialist named "Researcher-${runId}". Your job is to analyze requests and provide research insights.

When you receive a task from the orchestrator:
1. Analyze the request
2. Provide a brief research summary (2-3 sentences)
3. Send your findings back to the orchestrator

When you receive a request to collaborate with another worker:
1. Send them a brief message with relevant context
2. Report back to the orchestrator when done

Keep all responses under 100 words. Always respond to "${orchestratorName}".`,
    },
    {
      name: `Analyst-${runId}`,
      role: 'Data Analyst',
      task: `You are a Data Analyst named "Analyst-${runId}". Your job is to analyze data and provide insights.

When you receive a task from the orchestrator:
1. Process the information provided
2. Provide analytical insights (2-3 key points)
3. Send your analysis back to the orchestrator

When you receive information from other workers:
1. Incorporate it into your analysis
2. Acknowledge receipt

Keep all responses under 100 words. Always respond to "${orchestratorName}".`,
    },
    {
      name: `Writer-${runId}`,
      role: 'Content Writer',
      task: `You are a Content Writer named "Writer-${runId}". Your job is to synthesize information into clear summaries.

When you receive information from the orchestrator:
1. Synthesize the inputs provided
2. Create a brief, clear summary (3-4 sentences)
3. Send the summary back to the orchestrator

Keep all responses under 100 words. Always respond to "${orchestratorName}".`,
    },
  ];

  const connectedWorkers = new Set();
  const workerResponses = new Map();
  const spawnedAgents = [];
  let finalSummary = null;

  // Step 1: Connect orchestrator
  console.log('1. Connecting orchestrator...');
  const orchestrator = new RelayClient({
    agentName: orchestratorName,
    socketPath,
    quiet: true,
  });

  orchestrator.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    logger.log(from, 'SAID', body);

    // Track responses from workers
    const worker = workers.find(w => w.name === from);
    if (worker) {
      if (!workerResponses.has(from)) {
        workerResponses.set(from, []);
      }
      workerResponses.get(from).push(body);
    }

    // Check for final summary from Writer
    if (from.includes('Writer') && body.length > 50) {
      finalSummary = body;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log(`   CLI: ${CLI}`);
  console.log('   Connected\n');

  // Step 2: Spawn all workers
  console.log(`2. Spawning ${workers.length} specialized workers...`);

  for (const worker of workers) {
    try {
      const result = await orchestrator.spawn({
        name: worker.name,
        cli: CLI,
        task: worker.task,
        cwd: projectRoot,
      });

      if (result.success) {
        console.log(`   ✓ ${worker.name} (${worker.role}) - PID: ${result.pid}`);
        spawnedAgents.push(worker.name);
      } else {
        console.log(`   ✗ ${worker.name} failed: ${result.error}`);
      }
    } catch (err) {
      console.log(`   ✗ ${worker.name} error: ${err.message}`);
    }
  }
  console.log('');

  // Step 3: Wait for workers to connect
  console.log('3. Waiting for workers to connect (max 60s)...');
  const connectStart = Date.now();
  const connectTimeout = 60000;

  while (Date.now() - connectStart < connectTimeout) {
    const agents = await orchestrator.listAgents();
    for (const worker of workers) {
      if (agents.some(a => a.name === worker.name)) {
        connectedWorkers.add(worker.name);
      }
    }
    if (connectedWorkers.size === workers.length) {
      console.log(`   All ${workers.length} workers connected!`);
      break;
    }
    const elapsed = Math.round((Date.now() - connectStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (${connectedWorkers.size}/${workers.length})`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\n');

  if (connectedWorkers.size < workers.length) {
    console.log(`   Warning: Only ${connectedWorkers.size}/${workers.length} workers connected`);
  }

  // Give workers time to initialize
  await new Promise(r => setTimeout(r, 5000));

  // Step 4: Execute orchestration workflow
  console.log('4. Executing orchestration workflow...\n');
  console.log('='.repeat(60));
  console.log('### ORCHESTRATION WORKFLOW ###\n');

  // Phase 1: Initial Research Task
  console.log('--- Phase 1: Research Task ---\n');
  const researchTask = 'Research the key benefits of multi-agent AI systems. Provide 2-3 main points.';
  const researcher = workers[0].name;

  if (connectedWorkers.has(researcher)) {
    logger.log(orchestratorName, `TO ${researcher}`, researchTask);
    orchestrator.sendMessage(researcher, researchTask);
    await new Promise(r => setTimeout(r, 20000));
  }

  // Phase 2: Analysis Task
  console.log('\n--- Phase 2: Analysis Task ---\n');
  const analysisTask = 'Analyze how multi-agent systems improve over single-agent approaches. Identify 2-3 key advantages.';
  const analyst = workers[1].name;

  if (connectedWorkers.has(analyst)) {
    logger.log(orchestratorName, `TO ${analyst}`, analysisTask);
    orchestrator.sendMessage(analyst, analysisTask);
    await new Promise(r => setTimeout(r, 20000));
  }

  // Phase 3: Inter-agent collaboration
  console.log('\n--- Phase 3: Inter-Agent Collaboration ---\n');
  const collabTask = `Share your research findings with ${analyst}. Send them a brief summary of your key points.`;

  if (connectedWorkers.has(researcher)) {
    logger.log(orchestratorName, `TO ${researcher}`, collabTask);
    orchestrator.sendMessage(researcher, collabTask);
    await new Promise(r => setTimeout(r, 15000));
  }

  // Phase 4: Synthesis
  console.log('\n--- Phase 4: Final Synthesis ---\n');
  const writer = workers[2].name;

  // Gather responses for synthesis
  const researchFindings = workerResponses.get(researcher)?.[0] || 'No research data';
  const analysisFindings = workerResponses.get(analyst)?.[0] || 'No analysis data';

  const synthesisTask = `Create a brief executive summary (3-4 sentences) combining these inputs:

RESEARCH: ${researchFindings.substring(0, 200)}...

ANALYSIS: ${analysisFindings.substring(0, 200)}...

Provide a clear, concise summary of the key takeaways.`;

  if (connectedWorkers.has(writer)) {
    logger.log(orchestratorName, `TO ${writer}`, synthesisTask);
    orchestrator.sendMessage(writer, synthesisTask);
    await new Promise(r => setTimeout(r, 25000));
  }

  // Step 5: Results
  console.log('\n' + '='.repeat(60));
  console.log('\n### WORKFLOW RESULTS ###\n');

  console.log('Worker Responses:');
  for (const [worker, responses] of workerResponses) {
    console.log(`\n  ${worker}: ${responses.length} response(s)`);
    for (const response of responses.slice(0, 2)) {
      console.log(`    - ${response.substring(0, 80)}...`);
    }
  }

  if (finalSummary) {
    console.log('\n--- Final Summary ---');
    console.log(finalSummary.substring(0, 500));
  }

  // Step 6: Cleanup
  console.log('\n\n5. Releasing all workers...');
  for (const name of spawnedAgents) {
    try {
      const result = await orchestrator.release(name);
      if (result.success) {
        console.log(`   ✓ Released ${name}`);
      } else {
        console.log(`   - ${name}: ${result.error || 'already exited'}`);
      }
    } catch (err) {
      console.log(`   - ${name}: ${err.message}`);
    }
  }

  logger.save();
  orchestrator.disconnect();
  console.log('\n6. Orchestrator disconnected\n');

  // Determine success
  const success = connectedWorkers.size >= 2 && workerResponses.size >= 2;

  console.log('='.repeat(60));
  if (success) {
    console.log(`=== Test 14 (SDK/${CLI.toUpperCase()}) PASSED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workers.length}`);
    console.log(`   Workers responded: ${workerResponses.size}/${workers.length}`);
    process.exit(0);
  } else {
    console.log(`=== Test 14 (SDK/${CLI.toUpperCase()}) FAILED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workers.length}`);
    console.log(`   Workers responded: ${workerResponses.size}/${workers.length}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
