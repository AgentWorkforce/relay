#!/usr/bin/env npx ts-node
/**
 * Standalone Discord Claude Bot
 *
 * Minimal Discord bot using Claude Code CLI - no agent-relay required.
 * Uses your Claude Code subscription (no API costs).
 *
 * Setup:
 *   1. Create Discord app: https://discord.com/developers/applications
 *   2. Bot → Add Bot → copy Token
 *   3. Bot → enable "Message Content Intent"
 *   4. OAuth2 → URL Generator → select "bot" scope + "Send Messages" permission
 *   5. Use generated URL to invite bot to your server
 *   6. Ensure `claude` CLI is logged in: `claude auth login`
 *
 * Run:
 *   DISCORD_TOKEN=... npx ts-node examples/discord-claude-standalone.ts
 */

import { Client, GatewayIntentBits, Message } from 'discord.js';
import { spawn } from 'child_process';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// Conversation history per channel/thread
const threads = new Map<string, Array<{ role: string; text: string }>>();

async function askClaude(prompt: string, history: Array<{ role: string; text: string }> = []): Promise<string> {
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

// Split long messages for Discord's 2000 char limit
function splitMessage(text: string, maxLength = 1900): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
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

client.on('ready', () => {
  console.log(`⚡ Discord bot logged in as ${client.user?.tag}`);
  console.log('   Mention the bot or DM it to chat!');
});

client.on('messageCreate', async (message: Message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check if bot was mentioned or it's a DM
  const isMentioned = message.mentions.has(client.user!);
  const isDM = !message.guild;

  if (!isMentioned && !isDM) return;

  // Get the text (remove mention)
  const text = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;

  // Use thread ID or channel ID for conversation tracking
  const threadId = message.channel.isThread()
    ? message.channel.id
    : message.reference?.messageId || message.channel.id;

  console.log(`[${new Date().toISOString()}] ${message.author.tag}: "${text}"`);

  // Get thread history
  const history = threads.get(threadId) || [];

  try {
    // Show typing indicator
    await message.channel.sendTyping();

    const response = await askClaude(text, history);

    // Update history (keep last 10 exchanges)
    history.push({ role: 'User', text });
    history.push({ role: 'Claude', text: response });
    threads.set(threadId, history.slice(-20));

    // Send response (split if too long)
    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await message.reply({ content: chunk, allowedMentions: { repliedUser: false } });
    }
  } catch (err) {
    console.error('Error:', err);
    await message.reply(`Error: ${err}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
