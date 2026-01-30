/**
 * SlackBridge - Bidirectional Slack ↔ Agent Relay bridge
 */

import { App } from '@slack/bolt';
import { RelayClient, getProjectPaths } from 'agent-relay';
import type { BridgeConfig, SlackMessage } from './types.js';

export class SlackBridge {
  private slack: App;
  private relay: RelayClient;
  private config: BridgeConfig;
  private threadMap: Map<string, string> = new Map();

  constructor(config: BridgeConfig) {
    this.config = config;

    // Initialize Slack app
    this.slack = new App({
      token: config.slackBotToken,
      appToken: config.slackAppToken,
      socketMode: true,
    });

    // Initialize relay client
    const paths = getProjectPaths();
    this.relay = new RelayClient({
      name: config.name,
      socketPath: config.socketPath || paths.socketPath,
    });

    this.setupSlackHandlers();
    this.setupRelayHandlers();
  }

  private setupSlackHandlers(): void {
    // Handle @mentions
    this.slack.event('app_mention', async ({ event, say }) => {
      const threadTs = event.thread_ts || event.ts;
      const text = this.cleanMention(event.text);

      console.log(`[Slack → Relay] ${event.user}: ${text}`);

      // Broadcast to agents
      await this.relay.broadcast(text, {
        source: 'slack',
        channel: event.channel,
        thread: threadTs,
        user: event.user,
      });

      // Store thread mapping for replies
      this.threadMap.set(threadTs, event.channel);
    });

    // Handle direct messages
    this.slack.event('message', async ({ event, say }) => {
      // Only handle DMs (channel type 'im')
      if (event.channel_type !== 'im') return;
      if ('bot_id' in event) return; // Ignore bot messages

      const msg = event as SlackMessage;
      console.log(`[Slack DM → Relay] ${msg.user}: ${msg.text}`);

      await this.relay.broadcast(msg.text || '', {
        source: 'slack-dm',
        channel: msg.channel,
        user: msg.user,
      });
    });
  }

  private setupRelayHandlers(): void {
    // Handle messages from agents
    this.relay.on('message', async (msg) => {
      // Skip our own messages
      if (msg.from === this.config.name) return;

      // Skip messages from other Slack sources
      if (msg.data?.source?.toString().startsWith('slack')) return;

      console.log(`[Relay → Slack] ${msg.from}: ${msg.body.substring(0, 50)}...`);

      // Determine target channel
      const channel = msg.data?.slackChannel?.toString() || this.config.defaultChannel;
      const thread = msg.data?.slackThread?.toString();

      try {
        await this.slack.client.chat.postMessage({
          channel,
          text: this.formatForSlack(msg.from, msg.body),
          thread_ts: thread,
          unfurl_links: false,
        });
      } catch (err) {
        console.error('[Relay → Slack] Failed to post:', err);
      }
    });

    this.relay.on('connected', () => {
      console.log(`[Relay] Connected as ${this.config.name}`);
    });

    this.relay.on('disconnected', () => {
      console.log('[Relay] Disconnected');
    });

    this.relay.on('error', (err) => {
      console.error('[Relay] Error:', err);
    });
  }

  private cleanMention(text: string): string {
    // Remove @mentions from the text
    return text.replace(/<@[A-Z0-9]+>/g, '').trim();
  }

  private formatForSlack(from: string, body: string): string {
    // Format agent message for Slack
    return `*${from}*: ${body}`;
  }

  async start(): Promise<void> {
    await this.relay.connect();
    await this.slack.start();

    // Announce presence
    await this.relay.broadcast(`${this.config.name} online - bridging Slack`);
  }

  async stop(): Promise<void> {
    await this.relay.broadcast(`${this.config.name} going offline`);
    await this.relay.disconnect();
    await this.slack.stop();
  }
}
