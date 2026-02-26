/**
 * Two agents collaborate on a marketing plan for the Agent Relay SDK.
 *
 * Claude and Codex join a shared channel, brainstorm together, and
 * produce a finished plan — no API key required, the SDK provisions
 * a fresh workspace automatically.
 *
 * Run:
 *   npm run build && npm run marketing-plan --workspace=packages/sdk
 */

import { AgentRelay } from '../relay.js';
import { RelaycastApi } from '../relaycast.js';

// Auto-provision a fresh isolated workspace — no signup or config needed.
const { apiKey } = await RelaycastApi.createWorkspace('marketing-plan-demo');

const relay = new AgentRelay({ env: { ...process.env, RELAY_API_KEY: apiKey } });

// Stream the conversation to the terminal as it happens.
relay.onMessageReceived = ({ from, text }) => {
  console.log(`\n[${from}]: ${text}`);
};

// Spawn Claude and Codex into a shared channel.
const [claude, codex] = await Promise.all([
  relay.claude.spawn({ channels: ['marketing'] }),
  relay.codex.spawn({ channels: ['marketing'] }),
]);

console.log('Claude and Codex are online. Starting the brainstorm...\n');

// Kick things off — Claude leads, Codex builds on it and writes the final plan.
const system = relay.human({ name: 'System' });

await system.sendMessage({
  to: claude.name,
  text: `You are collaborating with ${codex.name} in the #marketing channel.
Together you need to produce a concise marketing plan for the Agent Relay SDK —
a tool that lets developers run multiple AI agents (Claude, Codex, Gemini) in parallel,
have them communicate in real-time, and coordinate complex tasks.

Start by proposing 3 core messaging pillars for the SDK, then ask ${codex.name} to build on them.`,
});

await system.sendMessage({
  to: codex.name,
  text: `You are collaborating with ${claude.name} in the #marketing channel on a marketing plan
for the Agent Relay SDK. Listen to ${claude.name}'s pillars, add your perspective on developer
experience and multi-model flexibility, then write the final "## Marketing Plan" summary.`,
});

// Wait for Codex to post the finished plan (or 90 s timeout).
await new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, 90_000);

  relay.onMessageReceived = ({ from, text }) => {
    console.log(`\n[${from}]: ${text}`);
    if (from === codex.name && text.includes('## Marketing Plan')) {
      clearTimeout(timeout);
      resolve();
    }
  };
});

console.log('\nDone. Shutting down...');
await claude.release();
await codex.release();
await relay.shutdown();
