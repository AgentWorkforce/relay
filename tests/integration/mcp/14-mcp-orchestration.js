/**
 * Test 14: Complex Orchestration Test (MCP)
 *
 * A comprehensive multi-agent orchestration test that verifies:
 * - Task delegation from orchestrator to specialized workers
 * - Inter-agent communication via MCP
 * - Results aggregation
 * - Graceful error handling
 *
 * Usage:
 *   node tests/mcp/14-mcp-orchestration.js [cli]
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
  console.log(`=== Test 14: Complex Orchestration (MCP) - CLI: ${CLI.toUpperCase()} ===`);
  console.log(`${'='.repeat(60)}\n`);

  const runId = Date.now().toString(36);
  const orchestratorName = `MCPOrch-${runId}`;
  const outputDir = resolve(projectRoot, 'transcripts', `orchestration-mcp-${CLI}-${runId}`);
  const logger = new TranscriptLogger(outputDir);

  // Define specialized workers (using MCP tools for communication)
  const workers = [
    {
      name: `MCPResearcher-${runId}`,
      role: 'Research Specialist',
      task: `You are a Research Specialist named "MCPResearcher-${runId}".

IMPORTANT: Use the relay MCP tools to communicate:
- Use relay_send to send messages
- Use relay_inbox to check for new messages
- Use relay_who to see other agents

Your job is to analyze requests and provide research insights.

When you receive a task:
1. Analyze the request
2. Provide a brief research summary (2-3 sentences)
3. Use relay_send to send findings to "${orchestratorName}"

Keep responses under 100 words.`,
    },
    {
      name: `MCPAnalyst-${runId}`,
      role: 'Data Analyst',
      task: `You are a Data Analyst named "MCPAnalyst-${runId}".

IMPORTANT: Use the relay MCP tools to communicate:
- Use relay_send to send messages
- Use relay_inbox to check for new messages
- Use relay_who to see other agents

Your job is to analyze data and provide insights.

When you receive a task:
1. Process the information
2. Provide 2-3 analytical insights
3. Use relay_send to send analysis to "${orchestratorName}"

Keep responses under 100 words.`,
    },
    {
      name: `MCPWriter-${runId}`,
      role: 'Content Writer',
      task: `You are a Content Writer named "MCPWriter-${runId}".

IMPORTANT: Use the relay MCP tools to communicate:
- Use relay_send to send messages
- Use relay_inbox to check for new messages
- Use relay_who to see other agents

Your job is to synthesize information into clear summaries.

When you receive information:
1. Synthesize the inputs
2. Create a brief summary (3-4 sentences)
3. Use relay_send to send the summary to "${orchestratorName}"

Keep responses under 100 words.`,
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
    if (from.includes('MCPWriter') && body.length > 50) {
      finalSummary = body;
    }
  };

  await orchestrator.connect();
  console.log(`   Name: ${orchestratorName}`);
  console.log(`   CLI: ${CLI} (workers use MCP tools)`);
  console.log('   Connected\n');

  // Step 2: Spawn all workers
  console.log(`2. Spawning ${workers.length} MCP-enabled workers...`);

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
  console.log('3. Waiting for MCP workers to connect (max 60s)...');
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
      console.log(`   All ${workers.length} MCP workers connected!`);
      break;
    }
    const elapsed = Math.round((Date.now() - connectStart) / 1000);
    process.stdout.write(`\r   Waiting... ${elapsed}s (${connectedWorkers.size}/${workers.length})`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\n');

  if (connectedWorkers.size < workers.length) {
    console.log(`   Warning: Only ${connectedWorkers.size}/${workers.length} MCP workers connected`);
  }

  // Give workers time to initialize MCP
  await new Promise(r => setTimeout(r, 5000));

  // Step 4: Execute orchestration workflow
  console.log('4. Executing MCP orchestration workflow...\n');
  console.log('='.repeat(60));
  console.log('### MCP ORCHESTRATION WORKFLOW ###\n');

  // Phase 1: Initial Research Task
  console.log('--- Phase 1: Research Task (via MCP) ---\n');
  const researchTask = 'Research the key benefits of multi-agent AI systems for software development. Provide 2-3 main points. Use relay_send to respond.';
  const researcher = workers[0].name;

  if (connectedWorkers.has(researcher)) {
    logger.log(orchestratorName, `TO ${researcher}`, researchTask);
    orchestrator.sendMessage(researcher, researchTask);
    await new Promise(r => setTimeout(r, 25000));
  }

  // Phase 2: Analysis Task
  console.log('\n--- Phase 2: Analysis Task (via MCP) ---\n');
  const analysisTask = 'Analyze how multi-agent systems using MCP can coordinate effectively. Identify 2-3 advantages of the MCP protocol. Use relay_send to respond.';
  const analyst = workers[1].name;

  if (connectedWorkers.has(analyst)) {
    logger.log(orchestratorName, `TO ${analyst}`, analysisTask);
    orchestrator.sendMessage(analyst, analysisTask);
    await new Promise(r => setTimeout(r, 25000));
  }

  // Phase 3: Check who's online and inter-agent collaboration
  console.log('\n--- Phase 3: Agent Discovery & Collaboration ---\n');
  const discoveryTask = `Use relay_who to see who else is online, then share a brief insight with ${analyst} using relay_send.`;

  if (connectedWorkers.has(researcher)) {
    logger.log(orchestratorName, `TO ${researcher}`, discoveryTask);
    orchestrator.sendMessage(researcher, discoveryTask);
    await new Promise(r => setTimeout(r, 20000));
  }

  // Phase 4: Synthesis
  console.log('\n--- Phase 4: Final Synthesis (via MCP) ---\n');
  const writer = workers[2].name;

  // Gather responses for synthesis
  const researchFindings = workerResponses.get(researcher)?.[0] || 'Multi-agent systems enable parallel task execution';
  const analysisFindings = workerResponses.get(analyst)?.[0] || 'MCP provides standardized communication protocols';

  const synthesisTask = `Create a brief executive summary combining these inputs:

RESEARCH: ${researchFindings.substring(0, 200)}

ANALYSIS: ${analysisFindings.substring(0, 200)}

Synthesize into 3-4 clear sentences. Use relay_send to send your summary.`;

  if (connectedWorkers.has(writer)) {
    logger.log(orchestratorName, `TO ${writer}`, synthesisTask);
    orchestrator.sendMessage(writer, synthesisTask);
    await new Promise(r => setTimeout(r, 30000));
  }

  // Step 5: Results
  console.log('\n' + '='.repeat(60));
  console.log('\n### MCP WORKFLOW RESULTS ###\n');

  console.log('MCP Worker Responses:');
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
  console.log('\n\n5. Releasing all MCP workers...');
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
    console.log(`=== Test 14 (MCP/${CLI.toUpperCase()}) PASSED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workers.length}`);
    console.log(`   Workers responded: ${workerResponses.size}/${workers.length}`);
    process.exit(0);
  } else {
    console.log(`=== Test 14 (MCP/${CLI.toUpperCase()}) FAILED ===`);
    console.log(`   Workers connected: ${connectedWorkers.size}/${workers.length}`);
    console.log(`   Workers responded: ${workerResponses.size}/${workers.length}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
