#!/usr/bin/env npx ts-node
/**
 * Standalone Slack Claude Bot
 *
 * Minimal Slack bot using Claude Code CLI - no agent-relay required.
 * Uses your Claude Code subscription (no API costs).
 *
 * Setup:
 *   1. Create Slack app: https://api.slack.com/apps
 *   2. Enable Socket Mode → get App Token (xapp-...)
 *   3. OAuth & Permissions → add scopes: app_mentions:read, chat:write
 *   4. Install to workspace → get Bot Token (xoxb-...)
 *   5. Event Subscriptions → Subscribe to: app_mention
 *   6. Ensure `claude` CLI is logged in: `claude auth login`
 *
 * Run:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... ./examples/slack-claude-standalone.ts
 */

import { App } from '@slack/bolt';
import { spawn } from 'child_process';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  socketMode: true,
});

// Conversation history per thread
const threads = new Map<string, Array<{ role: string; text: string }>>();

async function askClaude(prompt: string, history: Array<{ role: string; text: string }> = []): Promise<string> {
  // Build context from history
  let fullPrompt = prompt;
  if (history.length > 0) {
    const context = history.map((m) => `${m.role}: ${m.text}`).join('\n');
    fullPrompt = `Previous conversation:\n${context}\n\nUser: ${prompt}`;
  }

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['--print', fullPrompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    claude.stdout.on('data', (d) => (output += d));
    claude.stderr.on('data', (d) => console.error('[claude stderr]', d.toString()));

    claude.on('close', (code) => {
      code === 0 ? resolve(output.trim()) : reject(new Error(`Exit ${code}`));
    });

    setTimeout(() => {
      claude.kill();
      reject(new Error('Timeout'));
    }, 120000);
  });
}

app.event('app_mention', async ({ event, say }) => {
  const threadId = event.thread_ts || event.ts;
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  console.log(`[${new Date().toISOString()}] @mention: "${text}"`);

  // Get thread history
  const history = threads.get(threadId) || [];

  try {
    const response = await askClaude(text, history);

    // Update history (keep last 10 exchanges)
    history.push({ role: 'User', text });
    history.push({ role: 'Claude', text: response });
    threads.set(threadId, history.slice(-20));

    await say({ text: response, thread_ts: threadId });
  } catch (err) {
    console.error('Error:', err);
    await say({ text: `Error: ${err}`, thread_ts: threadId });
  }
});

(async () => {
  await app.start();
  console.log('⚡ Slack Claude bot running (using Claude Code subscription)');
  console.log('   Mention the bot in any channel to chat!');
})();
