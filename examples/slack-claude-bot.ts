/**
 * Slack Claude Bot via Agent Relay
 *
 * A simple Slack bot that uses Claude Code CLI (subscription-based, no API costs)
 * bridged through agent-relay for message coordination.
 *
 * Setup:
 *   1. Create a Slack app at https://api.slack.com/apps
 *   2. Enable Socket Mode and get an App Token (xapp-...)
 *   3. Add Bot Token Scopes: app_mentions:read, chat:write, channels:history
 *   4. Install to workspace and get Bot Token (xoxb-...)
 *   5. Ensure `claude` CLI is installed and logged in
 *   6. Start agent-relay daemon: `agent-relay up`
 *
 * Run:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... npx ts-node examples/slack-claude-bot.ts
 */

import { App } from '@slack/bolt';
import { spawn, ChildProcess } from 'child_process';
import { RelayClient } from 'agent-relay';
import { getProjectPaths } from 'agent-relay';

// Configuration
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const BOT_NAME = process.env.BOT_NAME || 'SlackBot';

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN');
  process.exit(1);
}

// Initialize Slack app with Socket Mode
const slack = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// Initialize agent-relay client
const paths = getProjectPaths();
const relay = new RelayClient({
  name: BOT_NAME,
  socketPath: paths.socketPath,
});

// Track Slack threads to relay threads
const threadMap = new Map<string, string>();

/**
 * Ask Claude using the CLI (uses subscription, not API)
 */
async function askClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['--print', prompt], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let error = '';

    claude.stdout.on('data', (data) => {
      output += data.toString();
    });

    claude.stderr.on('data', (data) => {
      error += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(error || `Claude exited with code ${code}`));
      }
    });

    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error('Claude response timeout'));
    }, 120000);

    claude.on('close', () => clearTimeout(timeout));
  });
}

/**
 * Handle Slack @mentions
 */
slack.event('app_mention', async ({ event, say }) => {
  const threadTs = event.thread_ts || event.ts;
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  console.log(`[Slack] @mention in ${event.channel}: ${text}`);

  try {
    // Notify relay that we received a Slack message
    await relay.send({
      to: '*',
      body: `[Slack ${event.channel}] ${text}`,
      data: { source: 'slack', channel: event.channel, thread: threadTs },
    });

    // Get response from Claude
    const response = await askClaude(text);

    // Post response to Slack
    await say({
      text: response,
      thread_ts: threadTs,
    });

    // Notify relay of the response
    await relay.send({
      to: '*',
      body: `[Slack Response] ${response.substring(0, 200)}...`,
      data: { source: 'slack-response', channel: event.channel },
    });
  } catch (err) {
    console.error('[Slack] Error:', err);
    await say({
      text: `Sorry, I encountered an error: ${err instanceof Error ? err.message : 'Unknown error'}`,
      thread_ts: threadTs,
    });
  }
});

/**
 * Handle incoming relay messages - forward to Slack
 */
relay.on('message', async (msg) => {
  // Skip messages from ourselves or other Slack sources
  if (msg.from === BOT_NAME || msg.data?.source?.startsWith('slack')) {
    return;
  }

  console.log(`[Relay] Message from ${msg.from}: ${msg.body}`);

  // Check if message specifies a Slack channel
  const targetChannel = msg.data?.slackChannel || process.env.SLACK_DEFAULT_CHANNEL;

  if (targetChannel) {
    try {
      await slack.client.chat.postMessage({
        channel: targetChannel,
        text: `*${msg.from}*: ${msg.body}`,
        thread_ts: msg.data?.slackThread,
      });
    } catch (err) {
      console.error('[Relay→Slack] Failed to post:', err);
    }
  }
});

/**
 * Handle relay connection events
 */
relay.on('connected', () => {
  console.log(`[Relay] Connected as ${BOT_NAME}`);
});

relay.on('disconnected', () => {
  console.log('[Relay] Disconnected, will reconnect...');
});

/**
 * Startup
 */
async function main() {
  try {
    // Connect to relay daemon
    await relay.connect();
    console.log(`[Relay] Connected to ${paths.socketPath}`);

    // Start Slack app
    await slack.start();
    console.log('[Slack] Bot is running!');

    // Announce presence
    await relay.broadcast(`${BOT_NAME} online - bridging Slack ↔ Relay`);

    console.log('\nReady! Mention the bot in Slack to interact.');
    console.log('Messages from relay agents will be forwarded to Slack.\n');
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await relay.disconnect();
  await slack.stop();
  process.exit(0);
});

main();
