/**
 * Two agents collaborate on a marketing plan for the Agent Relay SDK.
 *
 * Claude and Codex join a shared channel, brainstorm together, and
 * produce a finished plan — all coordinated through Agent Relay.
 *
 * Run:
 *   RELAY_API_KEY=<key> npx tsx packages/sdk/src/examples/marketing-plan.ts
 */

import { AgentRelay } from '../relay.js';

const relay = new AgentRelay();

// Stream the conversation to the terminal as it happens
relay.onMessageReceived = ({ from, text }) => {
  console.log(`\n[${from}]: ${text}`);
};

// Spawn Claude and Codex into a shared channel
const [claude, codex] = await Promise.all([
  relay.claude.spawn({ channels: ['marketing'] }),
  relay.codex.spawn({ channels: ['marketing'] }),
]);

console.log('Claude and Codex are online. Starting the brainstorm...\n');

// Kick things off — Claude leads, Codex contributes
const system = relay.human({ name: 'System' });

await system.sendMessage({
  to: claude.name,
  text: `You are collaborating with an AI agent called ${codex.name} in the #marketing channel.
Together you need to produce a concise marketing plan for the Agent Relay SDK —
a tool that lets developers run multiple AI agents (Claude, Codex, Gemini) in parallel,
have them communicate in real-time, and coordinate complex tasks.

Start by proposing 3 core messaging pillars for the SDK. Then ask ${codex.name} to build on them.
Keep it tight — the final plan should fit in a single message.`,
});

await system.sendMessage({
  to: codex.name,
  text: `You are collaborating with ${claude.name} in the #marketing channel on a marketing plan
for the Agent Relay SDK. Listen to ${claude.name}'s pillars, add your own angle (especially
around developer experience and multi-model flexibility), then synthesise everything into
a final "Marketing Plan" summary and post it to the channel.`,
});

// Wait for the conversation to finish (agents signal done or 60 s timeout)
await new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, 60_000);

  relay.onMessageReceived = ({ from, text }) => {
    console.log(`\n[${from}]: ${text}`);
    // Codex posts the final plan
    if (from === codex.name && text.toLowerCase().includes('marketing plan')) {
      clearTimeout(timeout);
      resolve();
    }
  };
});

console.log('\nDone. Shutting down...');
await claude.release();
await codex.release();
await relay.shutdown();
