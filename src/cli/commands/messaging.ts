import { Command } from 'commander';
import { createRelaycastClient as createRelaycastClientSdk } from '@agent-relay/sdk';
import { getProjectPaths } from '@agent-relay/config';

import { createAgentRelayClient } from '../lib/client-factory.js';
import { parseSince } from '../lib/formatting.js';

type ExitFn = (code: number) => never;

interface RelaycastMessage {
  id: string;
  agent_name: string;
  text: string;
  created_at: string;
}

interface RelaycastUnreadChannel {
  channel_name: string;
  unread_count: number;
}

interface RelaycastMention {
  id: string;
  channel_name: string;
  agent_name: string;
  text: string;
  created_at: string;
}

interface RelaycastUnreadDm {
  conversation_id: string;
  from: string;
  unread_count: number;
  last_message: string | null;
}

interface RelaycastInbox {
  unread_channels: RelaycastUnreadChannel[];
  mentions: RelaycastMention[];
  unread_dms: RelaycastUnreadDm[];
}

export interface MessagingRelaycastClient {
  message(id: string): Promise<RelaycastMessage>;
  messages(
    channel: string,
    options?: { limit?: number; before?: string; after?: string }
  ): Promise<RelaycastMessage[]>;
  inbox(): Promise<RelaycastInbox>;
}

export interface MessagingBrokerClient {
  sendMessage(input: { to: string; text: string; from?: string; threadId?: string }): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

export interface MessagingDependencies {
  getProjectRoot: () => string;
  createClient: (cwd: string) => MessagingBrokerClient;
  createRelaycastClient: (options: { agentName: string }) => Promise<MessagingRelaycastClient>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function defaultExit(code: number): never {
  process.exit(code);
}

function createDefaultClient(cwd: string): MessagingBrokerClient {
  return createAgentRelayClient({ cwd }) as unknown as MessagingBrokerClient;
}

async function createDefaultRelaycastClient(options: {
  agentName: string;
}): Promise<MessagingRelaycastClient> {
  return createRelaycastClientSdk(options) as Promise<MessagingRelaycastClient>;
}

function withDefaults(overrides: Partial<MessagingDependencies> = {}): MessagingDependencies {
  return {
    getProjectRoot: () => getProjectPaths().projectRoot,
    createClient: createDefaultClient,
    createRelaycastClient: createDefaultRelaycastClient,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

export function registerMessagingCommands(
  program: Command,
  overrides: Partial<MessagingDependencies> = {}
): void {
  const deps = withDefaults(overrides);

  program
    .command('send')
    .description('Send a message to an agent')
    .argument('<agent>', 'Target agent name (or * for broadcast, #channel for channel)')
    .argument('<message>', 'Message to send')
    .option('--from <name>', 'Sender name', '__cli_sender__')
    .option('--thread <id>', 'Thread identifier')
    .action(async (agent: string, message: string, options: { from: string; thread?: string }) => {
      const client = deps.createClient(deps.getProjectRoot());

      try {
        await client.sendMessage({
          to: agent,
          text: message,
          from: options.from,
          threadId: options.thread,
        });
        deps.log(`Message sent to ${agent}`);
      } catch (err: any) {
        deps.error(`Failed to send message: ${err?.message || String(err)}`);
        deps.exit(1);
      } finally {
        await client.shutdown().catch(() => undefined);
      }
    });

  program
    .command('read', { hidden: true })
    .description('Read full message by ID (for truncated messages)')
    .argument('<id>', 'Message ID')
    .option('--storage <type>', 'Storage type override (jsonl, sqlite, memory)')
    .action(async (messageId: string) => {
      let relaycast: MessagingRelaycastClient;
      try {
        relaycast = await deps.createRelaycastClient({ agentName: '__cli_read__' });
      } catch (err: any) {
        deps.error(`Failed to initialize relaycast client: ${err?.message || String(err)}`);
        deps.error('Start the broker with `agent-relay up` and try again.');
        deps.exit(1);
        return;
      }

      try {
        const msg = await relaycast.message(messageId);
        deps.log(`From: ${msg.agent_name}`);
        deps.log('To: #channel');
        deps.log(`Time: ${new Date(msg.created_at).toISOString()}`);
        deps.log('---');
        deps.log(msg.text);
      } catch (err: any) {
        deps.error(`Failed to read message ${messageId}: ${err?.message || String(err)}`);
        deps.error('Ensure the broker is running (`agent-relay up`) and try again.');
        deps.exit(1);
      }
    });

  program
    .command('history')
    .description('Show recent message history')
    .option('-n, --limit <count>', 'Number of messages to show', '50')
    .option('-f, --from <agent>', 'Filter by sender')
    .option('-t, --to <agent>', 'Filter by recipient')
    .option('--thread <id>', 'Filter by thread ID')
    .option('--since <time>', 'Since time (e.g., "1h", "30m", "2024-01-01")')
    .option('--json', 'Output as JSON')
    .option('--storage <type>', 'Storage type override (jsonl, sqlite, memory)')
    .action(
      async (options: {
        limit?: string;
        from?: string;
        to?: string;
        thread?: string;
        since?: string;
        json?: boolean;
      }) => {
        const limit = Number.parseInt(options.limit ?? '50', 10) || 50;
        const sinceTs = parseSince(options.since);
        let relaycast: MessagingRelaycastClient;

        try {
          relaycast = await deps.createRelaycastClient({ agentName: '__cli_history__' });
        } catch (err: any) {
          deps.error(`Failed to initialize relaycast client: ${err?.message || String(err)}`);
          deps.error('Start the broker with `agent-relay up` and try again.');
          deps.exit(1);
          return;
        }

        try {
          const channel = options.to?.startsWith('#') ? options.to.slice(1) : 'general';
          const rawMessages = await relaycast.messages(channel, {
            limit: Math.max(limit * 2, 100),
          });

          let messages = rawMessages.filter((msg) => {
            if (options.from && msg.agent_name !== options.from) return false;
            if (sinceTs && Date.parse(msg.created_at) < sinceTs) return false;
            return true;
          });

          messages = messages.slice(0, limit);

          if (options.json) {
            const payload = messages.map((msg) => ({
              id: msg.id,
              ts: Date.parse(msg.created_at),
              timestamp: new Date(msg.created_at).toISOString(),
              from: msg.agent_name,
              to: `#${channel}`,
              thread: null,
              kind: 'message',
              body: msg.text,
              status: undefined,
            }));
            deps.log(JSON.stringify(payload, null, 2));
            return;
          }

          if (!messages.length) {
            deps.log('No messages found.');
            return;
          }

          messages.forEach((msg) => {
            const ts = new Date(msg.created_at).toISOString();
            const body = msg.text.length > 200 ? `${msg.text.slice(0, 197)}...` : msg.text;
            deps.log(`[${ts}] ${msg.agent_name} -> #${channel}: ${body}`);
          });
        } catch (err: any) {
          deps.error(`Failed to fetch history: ${err?.message || String(err)}`);
          deps.error('Ensure the broker is running (`agent-relay up`) and try again.');
          deps.exit(1);
        }
      }
    );

  program
    .command('inbox')
    .description('Show unread inbox summary')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      let relaycast: MessagingRelaycastClient;
      try {
        relaycast = await deps.createRelaycastClient({ agentName: '__cli_inbox__' });
      } catch (err: any) {
        deps.error(`Failed to initialize relaycast client: ${err?.message || String(err)}`);
        deps.exit(1);
        return;
      }

      try {
        const inbox = await relaycast.inbox();
        if (options.json) {
          deps.log(JSON.stringify(inbox, null, 2));
          return;
        }

        const hasContent =
          inbox.unread_channels.length > 0 || inbox.mentions.length > 0 || inbox.unread_dms.length > 0;

        if (!hasContent) {
          deps.log('Inbox is clear.');
          return;
        }

        if (inbox.unread_channels.length > 0) {
          deps.log('Unread Channels:');
          for (const item of inbox.unread_channels) {
            deps.log(`  #${item.channel_name}: ${item.unread_count}`);
          }
          deps.log('');
        }

        if (inbox.mentions.length > 0) {
          deps.log('Mentions:');
          for (const mention of inbox.mentions) {
            const preview = mention.text.length > 120 ? `${mention.text.slice(0, 117)}...` : mention.text;
            deps.log(`  [${mention.created_at}] #${mention.channel_name} @${mention.agent_name}: ${preview}`);
          }
          deps.log('');
        }

        if (inbox.unread_dms.length > 0) {
          deps.log('Unread DMs:');
          for (const dm of inbox.unread_dms) {
            deps.log(`  ${dm.from}: ${dm.unread_count}`);
          }
        }
      } catch (err: any) {
        deps.error(`Failed to fetch inbox: ${err?.message || String(err)}`);
        deps.exit(1);
      }
    });
}
