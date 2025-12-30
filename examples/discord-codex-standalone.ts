#!/usr/bin/env npx ts-node
/**
 * Standalone Discord Codex Bot
 *
 * Minimal Discord bot using OpenAI Codex CLI.
 *
 * Setup:
 *   1. Install Codex CLI: npm install -g @openai/codex
 *   2. Login: codex auth login
 *   3. Create Discord app with Message Content Intent (see README)
 *
 * Run:
 *   DISCORD_TOKEN=... npx ts-node examples/discord-codex-standalone.ts
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

const threads = new Map<string, Array<{ role: string; text: string }>>();

async function askCodex(prompt: string, history: Array<{ role: string; text: string }> = []): Promise<string> {
  let fullPrompt = prompt;
  if (history.length > 0) {
    const context = history.map((m) => `${m.role}: ${m.text}`).join('\n');
    fullPrompt = `Previous conversation:\n${context}\n\nUser: ${prompt}`;
  }

  return new Promise((resolve, reject) => {
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

client.on('ready', () => {
  console.log(`⚡ Discord bot logged in as ${client.user?.tag}`);
  console.log('   Mention the bot or DM it to chat!');
});

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user!);
  const isDM = !message.guild;

  if (!isMentioned && !isDM) return;

  const text = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!text) return;

  const threadId = message.channel.isThread()
    ? message.channel.id
    : message.reference?.messageId || message.channel.id;

  console.log(`[${new Date().toISOString()}] ${message.author.tag}: "${text}"`);

  const history = threads.get(threadId) || [];

  try {
    await message.channel.sendTyping();

    const response = await askCodex(text, history);

    history.push({ role: 'User', text });
    history.push({ role: 'Codex', text: response });
    threads.set(threadId, history.slice(-20));

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
