/**
 * Two agents collaborate on a marketing plan for the Agent Relay SDK.
 *
 * Claude posts its pillars to #marketing, Codex receives them automatically
 * (the broker injects channel messages into subscribed agent PTYs) and
 * writes the final plan — no API key required.
 *
 * Run:
 *   npm run build && npm run marketing-plan --workspace=packages/sdk
 */

import { randomBytes } from 'node:crypto';
import { AgentRelay } from '../relay.js';
import { RelaycastApi } from '../relaycast.js';

// Auto-provision a fresh isolated workspace — no signup or config needed.
const { apiKey } = await RelaycastApi.createWorkspace(`marketing-plan-${randomBytes(4).toString('hex')}`);

const relay = new AgentRelay({ env: { ...process.env, RELAY_API_KEY: apiKey } });

// Stream the conversation to the terminal as it happens.
relay.onMessageReceived = ({ from, text }) => {
  if (text.trim()) console.log(`\n[${from}]: ${text}`);
};

// Spawn both agents into the same channel.
const [claude, codex] = await Promise.all([
  relay.claude.spawn({ channels: ['marketing'] }),
  relay.codex.spawn({ channels: ['marketing'] }),
]);

console.log('Agents online. Kicking off...\n');

const system = relay.human({ name: 'System' });

// Tell Claude to post to #marketing — the broker will inject it into Codex's PTY.
await system.sendMessage({
  to: claude.name,
  text: `Post 3 punchy messaging pillars for the Agent Relay SDK to the #marketing channel
using relay_send. The SDK lets developers run Claude, Codex, and Gemini in parallel,
with real-time inter-agent messaging and workflow orchestration.`,
});

// Tell Codex to watch #marketing, build on Claude's pillars, and post the final plan.
await system.sendMessage({
  to: codex.name,
  text: `Watch the #marketing channel. When ${claude.name} posts its pillars,
add your perspective on developer experience and multi-model flexibility,
then post the complete "## Marketing Plan" to #marketing.`,
});

// Wait for Codex to post the finished plan (or 2 min timeout).
await new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, 120_000);

  relay.onMessageReceived = ({ from, text }) => {
    if (text.trim()) console.log(`\n[${from}]: ${text}`);
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
