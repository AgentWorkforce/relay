/**
 * Discord Claude Bot via Agent Relay
 *
 * A Discord bot that uses Claude Code CLI (subscription-based, no API costs)
 * bridged through agent-relay for message coordination.
 *
 * Setup:
 *   1. Create Discord app: https://discord.com/developers/applications
 *   2. Bot → Add Bot → copy Token
 *   3. Bot → enable "Message Content Intent"
 *   4. OAuth2 → URL Generator → "bot" scope + "Send Messages" + "Read Message History"
 *   5. Use generated URL to invite bot to your server
 *   6. Ensure `claude` CLI is installed and logged in
 *   7. Start agent-relay daemon: `agent-relay up`
 *
 * Run:
 *   DISCORD_TOKEN=... npx ts-node examples/discord-claude-bot.ts
 */

import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { spawn } from 'child_process';
import { RelayClient } from 'agent-relay';
import { getProjectPaths } from 'agent-relay';

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const BOT_NAME = process.env.BOT_NAME || 'DiscordBot';
const DEFAULT_CHANNEL_ID = process.env.DISCORD_DEFAULT_CHANNEL;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN');
  process.exit(1);
}

// Initialize Discord client
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// Initialize agent-relay client
const paths = getProjectPaths();
const relay = new RelayClient({
  name: BOT_NAME,
  socketPath: paths.socketPath,
});

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

    const timeout = setTimeout(() => {
      claude.kill();
      reject(new Error('Claude response timeout'));
    }, 120000);

    claude.on('close', () => clearTimeout(timeout));
  });
}

// Split long messages for Discord's 2000 char limit
function splitMessage(text: string, maxLength = 1900): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt === -1 || splitAt < maxLength / 2) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Handle Discord mentions
 */
discord.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(discord.user!);
  const isDM = !message.guild;

  if (!isMentioned && !isDM) return;

  const text = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;

  console.log(`[Discord] ${message.author.tag}: ${text}`);

  try {
    // Notify relay that we received a Discord message
    await relay.send({
      to: '*',
      body: `[Discord #${(message.channel as TextChannel).name || 'DM'}] ${message.author.tag}: ${text}`,
      data: {
        source: 'discord',
        channelId: message.channel.id,
        guildId: message.guild?.id,
        userId: message.author.id,
      },
    });

    // Show typing
    await message.channel.sendTyping();

    // Get response from Claude
    const response = await askClaude(text);

    // Send response to Discord
    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }

    // Notify relay of the response
    await relay.send({
      to: '*',
      body: `[Discord Response] ${response.substring(0, 200)}...`,
      data: { source: 'discord-response', channelId: message.channel.id },
    });
  } catch (err) {
    console.error('[Discord] Error:', err);
    await message.reply(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }
});

/**
 * Handle incoming relay messages - forward to Discord
 */
relay.on('message', async (msg) => {
  // Skip messages from ourselves or other Discord sources
  if (msg.from === BOT_NAME || msg.data?.source?.startsWith('discord')) {
    return;
  }

  console.log(`[Relay] Message from ${msg.from}: ${msg.body}`);

  // Check if message specifies a Discord channel
  const targetChannelId = msg.data?.discordChannel || DEFAULT_CHANNEL_ID;

  if (targetChannelId) {
    try {
      const channel = await discord.channels.fetch(targetChannelId);
      if (channel?.isTextBased()) {
        const chunks = splitMessage(`**${msg.from}**: ${msg.body}`);
        for (const chunk of chunks) {
          await (channel as TextChannel).send(chunk);
        }
      }
    } catch (err) {
      console.error('[Relay→Discord] Failed to post:', err);
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

discord.on('ready', () => {
  console.log(`[Discord] Logged in as ${discord.user?.tag}`);
});

/**
 * Startup
 */
async function main() {
  try {
    // Connect to relay daemon
    await relay.connect();
    console.log(`[Relay] Connected to ${paths.socketPath}`);

    // Login to Discord
    await discord.login(DISCORD_TOKEN);

    // Announce presence
    await relay.broadcast(`${BOT_NAME} online - bridging Discord ↔ Relay`);

    console.log('\nReady! Mention the bot in Discord to interact.');
    console.log('Messages from relay agents will be forwarded to Discord.\n');
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await relay.disconnect();
  discord.destroy();
  process.exit(0);
});

main();
