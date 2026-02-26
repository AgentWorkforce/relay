/**
 * Spawn Claude + Codex agents via agent-relay-broker for code review.
 * Run: npx tsx scripts/spawn-reviewers.ts
 */
import { AgentRelay, type Agent } from '@agent-relay/sdk';

async function main() {
  const relay = new AgentRelay({
    binaryPath: './target/debug/agent-relay-broker',
    channels: ['general'],
  });

  // Listen for all events
  relay.onDeliveryUpdate = (event) => {
    console.log(`[delivery] ${event.kind}:`, JSON.stringify(event));
  };
  relay.onMessageReceived = (msg) => {
    console.log(`\n[MSG ${msg.from} -> ${msg.to}]: ${msg.text}\n`);
  };
  relay.onAgentSpawned = (agent: Agent) => {
    console.log(`[spawned] ${agent.name}`);
  };
  relay.onAgentExited = (agent: Agent, code?: number) => {
    console.log(`[exited] ${agent.name} code=${code}`);
  };

  const human = relay.human({ name: 'Human' });

  // Spawn Claude reviewer
  console.log('Spawning Claude reviewer...');
  const reviewer = await relay.claude.spawn({
    name: 'Reviewer',
    channels: ['general'],
  });
  console.log('Spawned:', reviewer.name);

  // Wait for agent to be ready
  await new Promise((r) => setTimeout(r, 3000));

  // Send review task
  const msg = await human.sendMessage({
    to: reviewer.name,
    text: 'Do a thorough code review of this relay broker codebase. Check src/*.rs for any stubs, TODOs, unwrap() in production code, missing error handling, dead code, or incomplete implementations. Also check packages/sdk/src/*.ts for type safety issues and API consistency. Report your findings concisely.',
  });
  console.log('Sent review task, eventId:', msg.eventId);

  // Spawn Codex reviewer
  console.log('Spawning Codex reviewer...');
  const codexReviewer = await relay.codex.spawn({
    name: 'CodexReviewer',
    channels: ['general'],
  });
  console.log('Spawned:', codexReviewer.name);

  await new Promise((r) => setTimeout(r, 3000));

  const msg2 = await human.sendMessage({
    to: codexReviewer.name,
    text: 'Review the agent-relay broker codebase for quality. Check: 1) Rust code in src/ for correctness and error handling. 2) TypeScript SDK in packages/sdk/src/ for type safety. 3) Tests in tests/ for coverage gaps. Report findings concisely.',
  });
  console.log('Sent review task, eventId:', msg2.eventId);

  // List active agents
  const agents = await relay.listAgents();
  console.log(
    '\nActive agents:',
    agents.map((a) => `${a.name} (${a.runtime})`)
  );

  // Wait for agents to work, monitoring output
  console.log('\nMonitoring agent output (5 min timeout)...\n');

  const timeout = setTimeout(
    async () => {
      console.log('\nTimeout reached. Shutting down...');
      await relay.shutdown();
      process.exit(0);
    },
    5 * 60 * 1000
  );

  // Wait for both to exit
  try {
    await Promise.race([
      Promise.all([reviewer.waitForExit(4 * 60 * 1000), codexReviewer.waitForExit(4 * 60 * 1000)]),
      new Promise((r) => setTimeout(r, 4.5 * 60 * 1000)),
    ]);
  } catch (e) {
    console.log('Wait error:', e);
  }

  clearTimeout(timeout);
  console.log('\nDone. Shutting down...');
  await relay.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
