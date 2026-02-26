/**
 * Two agents collaborate on a marketing plan for the Agent Relay SDK.
 *
 * Claude proposes pillars, Codex builds on them and writes the final plan —
 * no API key required, the SDK provisions a fresh workspace automatically.
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

// Spawn Claude and Codex.
const [claude, codex] = await Promise.all([
  relay.claude.spawn({ channels: ['marketing'] }),
  relay.codex.spawn({ channels: ['marketing'] }),
]);

console.log('Agents online. Starting brainstorm...\n');

const system = relay.human({ name: 'System' });

// ── Step 1: Claude proposes the pillars ─────────────────────────────────────

// Wait for Claude's response before looping in Codex.
const claudeResponse = await new Promise<string>((resolve) => {
  relay.onMessageReceived = ({ from, text }) => {
    if (from === claude.name && text.trim().length > 0) {
      console.log(`[${from}]: ${text}\n`);
      resolve(text);
    }
  };

  system.sendMessage({
    to: claude.name,
    text: `Propose 3 core messaging pillars for the Agent Relay SDK —
a tool that lets developers run multiple AI agents (Claude, Codex, Gemini) in parallel,
have them communicate in real-time, and coordinate complex multi-step tasks.
Keep it punchy. One sentence per pillar.`,
  });
});

// ── Step 2: Codex gets Claude's pillars and writes the final plan ────────────

await new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, 90_000);

  relay.onMessageReceived = ({ from, text }) => {
    console.log(`[${from}]: ${text}\n`);
    if (from === codex.name && text.includes('## Marketing Plan')) {
      clearTimeout(timeout);
      resolve();
    }
  };

  system.sendMessage({
    to: codex.name,
    text: `${claude.name} proposed these pillars for the Agent Relay SDK:

${claudeResponse}

Add your perspective on developer experience and multi-model flexibility,
then write the complete "## Marketing Plan" (channels, tactics, target audience).`,
  });
});

console.log('Done. Shutting down...');
await claude.release();
await codex.release();
await relay.shutdown();
