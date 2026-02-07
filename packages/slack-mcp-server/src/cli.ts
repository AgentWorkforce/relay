#!/usr/bin/env node

/**
 * CLI client for the Headless Slack MCP Server.
 *
 * Works directly against the SQLite database (no server needed).
 * Useful for administration, debugging, and inspecting workspace state.
 *
 * Usage:
 *   slack-mcp-cli register <name> [--workspace <ws>]
 *   slack-mcp-cli channels
 *   slack-mcp-cli messages <channel> [--limit N]
 *   slack-mcp-cli post <channel> <text>
 *   slack-mcp-cli dm <agent> <text>
 *   slack-mcp-cli inbox
 *   slack-mcp-cli agents
 *   slack-mcp-cli search <query>
 */

import { Command } from 'commander';
import { Storage } from './storage.js';
import { Engine } from './engine.js';

function createEngine(dbPath: string, workspace: string): Engine {
  const storage = new Storage(dbPath);
  return new Engine(storage, workspace);
}

const program = new Command();

program
  .name('slack-mcp-cli')
  .description('CLI client for Headless Slack MCP Server')
  .version('0.1.0')
  .option('--db <path>', 'Database path', process.env.SLACK_MCP_DB ?? 'slack.db')
  .option('--workspace <name>', 'Workspace name', process.env.SLACK_MCP_WORKSPACE ?? 'default');

function getEngine(): Engine {
  const opts = program.opts();
  return createEngine(opts.db, opts.workspace);
}

// --- register ---
program
  .command('register <name>')
  .description('Register an agent in the workspace')
  .option('--persona <text>', 'Agent persona description')
  .action((name: string, opts: { persona?: string }) => {
    const engine = getEngine();
    const result = engine.register(name, opts.persona);
    console.log(`Registered: ${result.agent.name} (${result.agent.id})`);
    console.log(`Workspace: ${result.workspace.name}`);
    console.log('Channels:');
    for (const ch of result.channels) {
      console.log(`  #${ch.name}${ch.topic ? ` — ${ch.topic}` : ''}`);
    }
  });

// --- channels ---
program
  .command('channels')
  .description('List channels')
  .option('--archived', 'Include archived channels')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((opts: { archived?: boolean; as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    const channels = engine.listChannels(agent.id, opts.archived);
    for (const ch of channels) {
      const archived = ch.is_archived ? ' [archived]' : '';
      console.log(`#${ch.name}${ch.topic ? ` — ${ch.topic}` : ''} (${ch.member_count ?? '?'} members)${archived}`);
    }
  });

// --- messages ---
program
  .command('messages <channel>')
  .description('Get messages from a channel')
  .option('--limit <n>', 'Max messages', '20')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((channel: string, opts: { limit: string; as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    engine.joinChannel(agent.id, channel);
    const messages = engine.getMessages(agent.id, channel, {
      limit: parseInt(opts.limit, 10),
    });
    for (const m of messages) {
      const time = new Date(m.created_at).toLocaleTimeString();
      const name = m.agent_name ?? m.agent_id;
      const thread = m.thread_id ? ` (thread ${m.thread_id})` : '';
      const replies = m.reply_count ? ` [${m.reply_count} replies]` : '';
      const reactions = m.reactions?.length
        ? `  ${m.reactions.map((r) => `:${r.emoji}: ${r.count}`).join(' ')}`
        : '';
      console.log(`[${time}] ${name}${thread}: ${m.body}${replies}${reactions}`);
      console.log(`  id: ${m.id}`);
    }
  });

// --- post ---
program
  .command('post <channel> <text>')
  .description('Post a message to a channel')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((channel: string, text: string, opts: { as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    engine.joinChannel(agent.id, channel);
    const msg = engine.postMessage(agent.id, channel, text);
    console.log(`Posted to #${channel} (id: ${msg.id})`);
  });

// --- reply ---
program
  .command('reply <thread_id> <text>')
  .description('Reply in a thread')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((threadId: string, text: string, opts: { as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    const msg = engine.replyToThread(agent.id, threadId, text);
    console.log(`Replied to thread ${threadId} (id: ${msg.id})`);
  });

// --- dm ---
program
  .command('dm <agent> <text>')
  .description('Send a direct message')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((targetAgent: string, text: string, opts: { as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    const msg = engine.sendDm(agent.id, targetAgent, text);
    console.log(`DM sent to ${targetAgent} (id: ${msg.id})`);
  });

// --- react ---
program
  .command('react <message_id> <emoji>')
  .description('Add an emoji reaction')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((messageId: string, emoji: string, opts: { as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    engine.addReaction(agent.id, messageId, emoji);
    console.log(`Added :${emoji}: to ${messageId}`);
  });

// --- inbox ---
program
  .command('inbox')
  .description('Check inbox for unread messages and mentions')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((opts: { as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    const inbox = engine.checkInbox(agent.id);

    if (
      inbox.unread_channels.length === 0 &&
      inbox.unread_dms.length === 0 &&
      inbox.mentions.length === 0
    ) {
      console.log('Inbox is empty.');
      return;
    }

    if (inbox.unread_channels.length > 0) {
      console.log('Unread channels:');
      for (const u of inbox.unread_channels) {
        console.log(`  #${u.channel_name}: ${u.unread_count} unread`);
      }
    }
    if (inbox.unread_dms.length > 0) {
      console.log('Unread DMs:');
      for (const u of inbox.unread_dms) {
        console.log(`  ${u.channel_name}: ${u.unread_count} unread`);
      }
    }
    if (inbox.mentions.length > 0) {
      console.log('Mentions:');
      for (const m of inbox.mentions) {
        const name = m.agent_name ?? m.agent_id;
        console.log(`  ${name}: ${m.body}`);
      }
    }
  });

// --- agents ---
program
  .command('agents')
  .description('List agents in the workspace')
  .option('--status <status>', 'Filter by status (online/offline/away/all)', 'all')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action((opts: { status: string; as: string }) => {
    const engine = getEngine();
    const { agent } = engine.register(opts.as);
    const agents = engine.listAgents(agent.id, opts.status);
    for (const a of agents) {
      console.log(`${a.name} [${a.status}]${a.persona ? ` — ${a.persona}` : ''}`);
    }
  });

// --- search ---
program
  .command('search <query>')
  .description('Search messages')
  .option('--channel <name>', 'Limit to channel')
  .option('--from <agent>', 'Limit to agent')
  .option('--limit <n>', 'Max results', '20')
  .option('--as <agent>', 'Act as agent', 'cli')
  .action(
    (
      query: string,
      opts: { channel?: string; from?: string; limit: string; as: string },
    ) => {
      const engine = getEngine();
      const { agent } = engine.register(opts.as);
      const messages = engine.searchMessages(agent.id, {
        query,
        channel_id: opts.channel,
        agent_id: opts.from,
        limit: parseInt(opts.limit, 10),
      });
      if (messages.length === 0) {
        console.log(`No results for "${query}"`);
        return;
      }
      for (const m of messages) {
        const name = m.agent_name ?? m.agent_id;
        console.log(`[${new Date(m.created_at).toLocaleString()}] ${name}: ${m.body}`);
        console.log(`  id: ${m.id}`);
      }
    },
  );

program.parse();
