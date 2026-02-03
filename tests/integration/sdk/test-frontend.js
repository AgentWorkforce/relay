import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function main() {
  const runId = Date.now().toString(36);
  const orchName = `TestOrch-${runId}`;

  console.log('1. Connecting orchestrator...');
  const orch = new RelayClient({ agentName: orchName, socketPath, quiet: true });

  let responseReceived = false;

  orch.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`\n*** MESSAGE FROM ${from}:`);
    console.log(`    ${body.substring(0, 300)}`);
    responseReceived = true;
  };

  await orch.connect();
  console.log('   Connected\n');

  // Spawn Frontend
  console.log('2. Spawning Frontend-Test...');
  try {
    const result = await orch.spawn({
      name: `Frontend-Test-${runId}`,
      cli: 'claude --dangerously-skip-permissions',
      task: 'You are a test agent. When you receive ANY message, respond immediately with "HELLO FROM FRONTEND - I received your message". Keep responses under 20 words.',
      orchestrator: orchName,
    });
    console.log(`   Spawned: PID ${result.pid}\n`);
  } catch (e) {
    console.log(`   SPAWN FAILED: ${e.message}`);
    process.exit(1);
  }

  // Wait for init
  console.log('3. Waiting 15s for agent to initialize...');
  await new Promise(r => setTimeout(r, 15000));

  // Check agents
  const agents = await orch.listAgents();
  console.log('   Connected agents:', agents.map(a => a.name).join(', '));

  // Send message
  console.log('\n4. Sending message to Frontend-Test...');
  orch.sendMessage(`Frontend-Test-${runId}`, 'Hello! Please respond with HELLO FROM FRONTEND.');

  // Wait for response
  console.log('5. Waiting 30s for response...\n');
  await new Promise(r => setTimeout(r, 30000));

  if (!responseReceived) {
    console.log('\n*** NO RESPONSE RECEIVED ***');
  }

  // Check log file
  const { readFileSync, existsSync } = await import('fs');
  const logPath = resolve(projectRoot, '.agent-relay', 'team', 'worker-logs', `Frontend-Test-${runId}.log`);
  console.log(`\n6. Checking log file: ${logPath}`);
  if (existsSync(logPath)) {
    const content = readFileSync(logPath, 'utf-8');
    console.log(`   Log size: ${content.length} bytes`);
    if (content.length > 0) {
      console.log('   Last 500 chars of log:');
      console.log(content.slice(-500));
    }
  } else {
    console.log('   Log file does not exist');
  }

  // Cleanup
  console.log('\n7. Releasing...');
  await orch.release(`Frontend-Test-${runId}`);
  orch.disconnect();
  console.log('Done');
}

main().catch(e => console.error(e));
