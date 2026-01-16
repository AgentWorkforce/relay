/**
 * Slack Bridge for Agent Relay
 *
 * Connects Slack to your agent network.
 * - Slack @mentions → broadcast to agents
 * - Agent messages → post to Slack
 */

import { SlackBridge } from './bridge.js';

async function main() {
  const bridge = new SlackBridge({
    name: process.env.BRIDGE_NAME || 'SlackBridge',
    slackBotToken: process.env.SLACK_BOT_TOKEN!,
    slackAppToken: process.env.SLACK_APP_TOKEN!,
    defaultChannel: process.env.DEFAULT_CHANNEL || '#agents',
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await bridge.stop();
    process.exit(0);
  });

  await bridge.start();
  console.log('Slack Bridge is running!');
  console.log('- Mention the bot in Slack to send to agents');
  console.log('- Agents can send to Slack via this bridge');
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
