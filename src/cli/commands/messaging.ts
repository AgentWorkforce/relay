import { Command } from 'commander';
import { RelayCast, AgentRelayClient } from '@agent-relay/sdk';
import { getProjectPaths } from '@agent-relay/config';

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

interface BrokerHistoryMessage {
  id?: string;
  event_id?: string;
  from?: string;
  target?: string;
  to?: string;
  text?: string;
  body?: string;
  thread_id?: string;
  threadId?: string;
  timestamp?: string;
  created_at?: string;
}

interface HistoryMessage {
  id: string;
  timestamp: string;
  from: string;
  to: string;
  thread: string | null;
  body: string;
}

interface RelaycastClientOptions {
  agentName: string;
  cwd: string;
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
  getMessageHistory(): Promise<BrokerHistoryMessage[]>;
  shutdown(): Promise<unknown>;
}

export interface MessagingDependencies {
  getProjectRoot: () => string;
  connectClient: (cwd: string) => MessagingBrokerClient | Promise<MessagingBrokerClient>;
  createClient: (cwd: string) => MessagingBrokerClient | Promise<MessagingBrokerClient>;
  createRelaycastClient: (options: RelaycastClientOptions) => Promise<MessagingRelaycastClient>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}

function defaultExit(code: number): never {
  process.exit(code);
}

async function createDefaultClient(cwd: string): Promise<MessagingBrokerClient> {
  // Connect to an existing broker if one is running, otherwise spawn
  try {
    const client = AgentRelayClient.connect({ cwd });
    return client as unknown as MessagingBrokerClient;
  } catch {
    const client = await AgentRelayClient.spawn({ cwd });
    return client as unknown as MessagingBrokerClient;
  }
}

async function connectDefaultClient(cwd: string): Promise<MessagingBrokerClient> {
  const client = AgentRelayClient.connect({ cwd });
  return client as unknown as MessagingBrokerClient;
}

function resolveConfiguredSender(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.AGENT_RELAY_SENDER?.trim();
  if (explicit) {
    return explicit;
  }
  return undefined;
}

function hasExplicitRelaycastApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RELAY_API_KEY?.trim());
}

async function resolveRelaycastApiKey(cwd: string): Promise<string> {
  const envKey = process.env.RELAY_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  const client = AgentRelayClient.connect({ cwd });
  try {
    const session = await client.getSession();
    const workspaceKey = session.workspace_key?.trim();
    if (workspaceKey) {
      return workspaceKey;
    }
  } finally {
    await client.shutdown().catch(() => undefined);
  }

  throw new Error('Relaycast API key not found in RELAY_API_KEY or the running broker session');
}

async function createDefaultRelaycastClient(options: RelaycastClientOptions): Promise<MessagingRelaycastClient> {
  const apiKey = await resolveRelaycastApiKey(options.cwd);

  const baseUrl = process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
  const relaycast = new RelayCast({ apiKey, baseUrl });
  const registration = await relaycast.agents.registerOrGet({
    name: options.agentName,
    type: 'agent',
  });
  return relaycast.as(registration.token) as unknown as MessagingRelaycastClient;
}

function withDefaults(overrides: Partial<MessagingDependencies> = {}): MessagingDependencies {
  return {
    getProjectRoot: () => getProjectPaths().projectRoot,
    connectClient: connectDefaultClient,
    createClient: createDefaultClient,
    createRelaycastClient: createDefaultRelaycastClient,
    log: (...args: unknown[]) => console.log(...args),
    error: (...args: unknown[]) => console.error(...args),
    exit: defaultExit,
    ...overrides,
  };
}

function normalizeBrokerHistoryMessage(message: BrokerHistoryMessage): HistoryMessage | null {
  const timestamp = message.timestamp ?? message.created_at;
  const from = message.from?.trim();
  const to = (message.target ?? message.to)?.trim();
  const body = (message.text ?? message.body)?.trim();
  if (!timestamp || !from || !to || !body) {
    return null;
  }
  const parsedTimestamp = Date.parse(timestamp);
  if (Number.isNaN(parsedTimestamp)) {
    return null;
  }

  return {
    id: message.id ?? message.event_id ?? `${timestamp}:${from}:${to}`,
    timestamp: new Date(parsedTimestamp).toISOString(),
    from,
    to,
    thread: message.thread_id ?? message.threadId ?? null,
    body,
  };
}

function filterHistoryMessages(
  messages: HistoryMessage[],
  options: { from?: string; to?: string; thread?: string },
  sinceTs: number | null
): HistoryMessage[] {
  return messages.filter((message) => {
    if (options.from && message.from !== options.from) return false;
    if (options.to && message.to !== options.to) return false;
    if (options.thread && message.thread !== options.thread) return false;
    if (sinceTs && Date.parse(message.timestamp) < sinceTs) return false;
    return true;
  });
}

function formatHistoryBody(body: string): string {
  return body.length > 200 ? `${body.slice(0, 197)}...` : body;
}

function renderHistoryMessages(
  deps: MessagingDependencies,
  messages: HistoryMessage[],
  jsonOutput: boolean
): void {
  if (jsonOutput) {
    const payload = messages.map((message) => ({
      id: message.id,
      ts: Date.parse(message.timestamp),
      timestamp: message.timestamp,
      from: message.from,
      to: message.to,
      thread: message.thread,
      kind: 'message',
      body: message.body,
      status: undefined,
    }));
    deps.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!messages.length) {
    deps.log('No messages found.');
    return;
  }

  messages.forEach((message) => {
    deps.log(`[${message.timestamp}] ${message.from} -> ${message.to}: ${formatHistoryBody(message.body)}`);
  });
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
    .option('--from <name>', 'Sender name (defaults to the broker local sender when omitted)')
    .option('--thread <id>', 'Thread identifier')
    .action(async (agent: string, message: string, options: { from?: string; thread?: string }) => {
      let client: MessagingBrokerClient;
      try {
        client = await deps.createClient(deps.getProjectRoot());
      } catch (err: any) {
        deps.error(`Failed to connect to broker: ${err?.message || String(err)}`);
        deps.error('Start the broker with `agent-relay up` and try again.');
        deps.exit(1);
        return;
      }

      try {
        const configuredSender = options.from?.trim() || resolveConfiguredSender();
        await client.sendMessage({
          to: agent,
          text: message,
          ...(configuredSender ? { from: configuredSender } : {}),
          ...(options.thread ? { threadId: options.thread } : {}),
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
        relaycast = await deps.createRelaycastClient({
          agentName: '__cli_read__',
          cwd: deps.getProjectRoot(),
        });
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
        const sinceTs = parseSince(options.since) ?? null;
        const projectRoot = deps.getProjectRoot();
        const hasRelaycastApiKey = hasExplicitRelaycastApiKey();
        let localHistoryError: unknown;
        let localBrokerReachable = false;
        let localClient: MessagingBrokerClient | undefined;

        try {
          localClient = await deps.connectClient(projectRoot);
          localBrokerReachable = true;
          const rawMessages = await localClient.getMessageHistory();
          const localMessages = rawMessages
            .map(normalizeBrokerHistoryMessage)
            .filter((message): message is HistoryMessage => message !== null);
          const filteredMessages = filterHistoryMessages(localMessages, options, sinceTs).slice(0, limit);
          renderHistoryMessages(deps, filteredMessages, Boolean(options.json));
          return;
        } catch (err) {
          localHistoryError = err;
        } finally {
          await localClient?.shutdown().catch(() => undefined);
        }

        if (!localBrokerReachable && !hasRelaycastApiKey) {
          const detail =
            localHistoryError instanceof Error ? localHistoryError.message : String(localHistoryError);
          deps.error(`Failed to read local broker history: ${detail}`);
          deps.error(
            'No Relaycast API key found in RELAY_API_KEY. Start the local broker with `agent-relay up` and retry, or set RELAY_API_KEY to read Relaycast history.'
          );
          deps.exit(1);
          return;
        }

        try {
          const relaycast = await deps.createRelaycastClient({
            agentName: '__cli_history__',
            cwd: projectRoot,
          });
          const channel = options.to?.startsWith('#') ? options.to.slice(1) : 'general';
          const rawMessages = await relaycast.messages(channel, {
            limit: Math.max(limit * 2, 100),
          });
          const relaycastMessages: HistoryMessage[] = rawMessages.map((msg) => ({
            id: msg.id,
            timestamp: new Date(msg.created_at).toISOString(),
            from: msg.agent_name,
            to: `#${channel}`,
            thread: null,
            body: msg.text,
          }));
          const filteredMessages = filterHistoryMessages(relaycastMessages, options, sinceTs).slice(0, limit);
          renderHistoryMessages(deps, filteredMessages, Boolean(options.json));
        } catch (err: any) {
          const relaycastError = err?.message || String(err);
          if (!hasRelaycastApiKey && relaycastError.includes('Relaycast API key not found')) {
            deps.error(
              'Relaycast history is unavailable because this broker is running in local-only mode and no RELAY_API_KEY is configured.'
            );
          } else {
            deps.error(`Failed to fetch relaycast history: ${relaycastError}`);
          }
          if (localHistoryError) {
            const detail =
              localHistoryError instanceof Error
                ? localHistoryError.message
                : String(localHistoryError);
            deps.error(`Local broker history was unavailable: ${detail}`);
          }
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
        relaycast = await deps.createRelaycastClient({
          agentName: '__cli_inbox__',
          cwd: deps.getProjectRoot(),
        });
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
