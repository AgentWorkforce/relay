/**
 * Runnable demo — shows the full AgentRelay message flow with real output.
 * Uses `cat` as a universally-available stand-in for agent CLIs.
 *
 * Run:
 *   npm run build && npm run demo
 */
import { AgentRelay } from '../relay.js';

const relay = new AgentRelay({ env: process.env });

// ── Event hooks ─────────────────────────────────────────────────────────────

relay.addListener('messageReceived', (message) => {
  console.log(`  📨 received  │ from=${message.from}  to=${message.to}  text="${message.text}"`);
});

relay.addListener('messageSent', (message) => {
  console.log(`  📤 sent      │ from=${message.from}  to=${message.to}  text="${message.text}"`);
});

relay.addListener('agentSpawned', (agent) => {
  console.log(`  🟢 spawned   │ ${agent.name} (${agent.runtime})`);
});

relay.addListener('agentReleased', (agent) => {
  console.log(`  🔴 released  │ ${agent.name}`);
});

relay.addListener('agentExited', (agent) => {
  console.log(`  ⚪ exited    │ ${agent.name}`);
});

// ── Spawn agents ────────────────────────────────────────────────────────────

console.log('\n─── Spawning agents ───\n');

const [agentA, agentB] = await Promise.all([
  relay.spawnAgent({
    name: 'AgentA',
    cli: 'claude',
    args: ['--print'],
    channels: ['general'],
  }),
  relay.spawnAgent({
    name: 'AgentB',
    cli: 'claude',
    args: ['--print'],
    channels: ['general'],
  }),
]);

// ── Send messages ───────────────────────────────────────────────────────────

console.log('\n─── Sending messages ───\n');

const human = relay.human({ name: 'System' });
await human.sendMessage({ to: agentA.name, text: 'Hello AgentA, welcome!' });
await human.sendMessage({ to: agentB.name, text: 'Hello AgentB, welcome!' });

// Agent-to-agent messaging
await agentA.sendMessage({ to: agentB.name, text: 'Hey B, got a task for you' });
await agentB.sendMessage({ to: agentA.name, text: 'On it!' });

// Threaded conversation
const thread = await human.sendMessage({ to: agentA.name, text: 'Status update?' });
await agentA.sendMessage({ to: human.name, text: 'All good!', threadId: thread.eventId });

// Priority messages
await human.sendMessage({ to: agentA.name, text: 'Critical alert!', priority: 0 });
await human.sendMessage({ to: agentB.name, text: 'Low priority FYI', priority: 4 });

// Small delay to let events propagate
await new Promise((r) => setTimeout(r, 500));

// ── List agents ─────────────────────────────────────────────────────────────

console.log('\n─── Active agents ───\n');

const agents = await relay.listAgents();
for (const agent of agents) {
  console.log(`  • ${agent.name}  runtime=${agent.runtime}  channels=[${agent.channels}]`);
}

// ── Release all ─────────────────────────────────────────────────────────────

console.log('\n─── Releasing agents ───\n');

for (const agent of agents) {
  await agent.release();
}

await new Promise((r) => setTimeout(r, 300));

// ── Shutdown ────────────────────────────────────────────────────────────────

await relay.shutdown();
console.log('\n─── Done ───\n');
