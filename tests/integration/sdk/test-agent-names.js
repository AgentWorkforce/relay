import { RelayClient } from '@agent-relay/sdk';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');
const socketPath = resolve(projectRoot, '.agent-relay', 'relay.sock');

async function testSpawn(agentName) {
  const runId = Date.now().toString(36);
  const orchName = `Orch-${runId}`;

  console.log(`\n=== Testing spawn: ${agentName} ===`);

  const orch = new RelayClient({ agentName: orchName, socketPath, quiet: true });

  let responseReceived = false;
  orch.onMessage = (from, payload) => {
    const body = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
    console.log(`   RESPONSE from ${from}: ${body.substring(0, 100)}`);
    responseReceived = true;
  };

  await orch.connect();

  const fullName = `${agentName}-${runId}`;
  try {
    const result = await orch.spawn({
      name: fullName,
      cli: 'claude --dangerously-skip-permissions',
      task: 'You are a test agent. Reply with "HELLO" when you receive a message.',
      orchestrator: orchName,
    });
    console.log(`   Spawned: PID ${result.pid}`);
  } catch (e) {
    console.log(`   SPAWN FAILED: ${e.message}`);
    orch.disconnect();
    return false;
  }

  // Wait for init
  await new Promise(r => setTimeout(r, 8000));

  // Send message
  console.log(`   Sending message...`);
  orch.sendMessage(fullName, 'Hello!');

  // Wait for response
  await new Promise(r => setTimeout(r, 15000));

  console.log(`   Response received: ${responseReceived}`);

  // Cleanup
  try { await orch.release(fullName); } catch {}
  orch.disconnect();

  return responseReceived;
}

async function main() {
  const names = ['Frontend', 'Backend', 'Infra', 'TestAgent', 'Worker'];
  const results = [];

  for (const name of names) {
    const success = await testSpawn(name);
    results.push({ name, success });
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n=== RESULTS ===');
  for (const { name, success } of results) {
    console.log(`  ${name}: ${success ? 'PASS' : 'FAIL'}`);
  }
}

main().catch(e => console.error(e));
