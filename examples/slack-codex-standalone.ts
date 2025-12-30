#!/usr/bin/env npx ts-node
/**
 * Standalone Slack Codex Bot
 *
 * Minimal Slack bot using OpenAI Codex CLI.
 *
 * Setup:
 *   1. Install Codex CLI: npm install -g @openai/codex
 *   2. Login: codex auth login
 *   3. Create Slack app with Socket Mode (see README)
 *
 * Run:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... npx ts-node examples/slack-codex-standalone.ts
 */

import { App } from '@slack/bolt';
import { spawn } from 'child_process';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken: process.env.SLACK_APP_TOKEN!,
  socketMode: true,
});

const threads = new Map<string, Array<{ role: string; text: string }>>();

async function askCodex(prompt: string, history: Array<{ role: string; text: string }> = []): Promise<string> {
  let fullPrompt = prompt;
  if (history.length > 0) {
    const context = history.map((m) => `${m.role}: ${m.text}`).join('\n');
    fullPrompt = `Previous conversation:\n${context}\n\nUser: ${prompt}`;
  }

  return new Promise((resolve, reject) => {
    // Use codex CLI with --print flag for non-interactive output
    const codex = spawn('codex', ['--print', fullPrompt], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    codex.stdout.on('data', (d) => (output += d));
    codex.stderr.on('data', (d) => console.error('[codex stderr]', d.toString()));

    codex.on('close', (code) => {
      code === 0 ? resolve(output.trim()) : reject(new Error(`Exit ${code}`));
    });

    setTimeout(() => {
      codex.kill();
      reject(new Error('Timeout'));
    }, 120000);
  });
}

app.event('app_mention', async ({ event, say }) => {
  const threadId = event.thread_ts || event.ts;
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  console.log(`[${new Date().toISOString()}] @mention: "${text}"`);

  const history = threads.get(threadId) || [];

  try {
    const response = await askCodex(text, history);

    history.push({ role: 'User', text });
    history.push({ role: 'Codex', text: response });
    threads.set(threadId, history.slice(-20));

    await say({ text: response, thread_ts: threadId });
  } catch (err) {
    console.error('Error:', err);
    await say({ text: `Error: ${err}`, thread_ts: threadId });
  }
});

(async () => {
  await app.start();
  console.log('⚡ Slack Codex bot running');
  console.log('   Mention the bot in any channel to chat!');
})();
