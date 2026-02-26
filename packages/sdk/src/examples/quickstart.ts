/**
 * Quickstart — shows the clean AgentRelay facade API.
 *
 * Run:
 *   npm run build && npm run quickstart
 *
 * Environment:
 *   RELAY_API_KEY   — Relaycast workspace key (required)
 *   AGENT_RELAY_BIN — path to agent-relay binary (optional)
 */
import { AgentRelay } from '../relay.js';

// The Relay is the communication backbone for your agents.
// Drop it into your codebase and let your agents communicate.
const relay = new AgentRelay();

// ── Event hooks ─────────────────────────────────────────────────────────────

relay.onMessageReceived = (message) => {
  console.log(`message received  → from=${message.from} to=${message.to}`);
};

relay.onMessageSent = (message) => {
  console.log(`message sent      → from=${message.from} to=${message.to}`);
};

relay.onAgentSpawned = (agent) => {
  console.log(`agent spawned     → ${agent.name} (${agent.runtime})`);
};

relay.onAgentReleased = (agent) => {
  console.log(`agent released    → ${agent.name}`);
};

relay.onAgentExited = (agent) => {
  console.log(`agent exited      → ${agent.name}`);
};

// ── Create agents with sane defaults, running locally ───────────────────────

const [codex, claude, gemini] = await Promise.all([
  relay.codex.spawn(),
  relay.claude.spawn(),
  relay.gemini.spawn(),
]);

// ── Configure messaging with custom CLI agents ─────────────────────────────

const worker1 = await relay.spawnPty({
  name: 'Worker1',
  cli: 'codex',
  args: ['--model', 'gpt-5'],
  channels: ['general'],
});

// ── Control messaging from non-agent sources ────────────────────────────────

const human = relay.human({ name: 'System' });
await human.sendMessage({ to: codex.name, text: 'Hello, world!' });

// ── List agents ─────────────────────────────────────────────────────────────

const agents = await relay.listAgents();
for (const agent of agents) {
  console.log(`  ${agent.name}  runtime=${agent.runtime}  channels=[${agent.channels}]`);
}

for (const agent of agents) {
  await agent.release();
}

await relay.shutdown();
