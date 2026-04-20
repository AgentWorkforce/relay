import { Command } from 'commander';
import { RelayCast, AgentRelayClient } from '@agent-relay/sdk';
import { getProjectPaths } from '@agent-relay/config';

import { defaultExit } from '../lib/exit.js';
import { parseSince } from '../lib/formatting.js';

type ExitFn = (code: number) => never;

interface RelaycastMessage {
  id: string;
  text: string;
  agentName?: string;
  createdAt?: string;
  agent_name?: string;
  created_at?: string;
}

interface RelaycastUnreadChannel {
  channelName?: string;
  unreadCount?: number;
  channel_name?: string;
  unread_count?: number;
}

interface RelaycastMention {
  id: string;
  text: string;
  channelName?: string;
  agentName?: string;
  createdAt?: string;
  channel_name?: string;
  agent_name?: string;
  created_at?: string;
}

interface RelaycastLastMessage {
  id: string;
  text: string;
  createdAt?: string;
  created_at?: string;
}

interface RelaycastUnreadDm {
  from: string;
  conversationId?: string;
  unreadCount?: number;
  lastMessage?: RelaycastLastMessage | null;
  conversation_id?: string;
  unread_count?: number;
  last_message?: RelaycastLastMessage | null;
}

interface RelaycastRecentReaction {
  emoji: string;
  messageId?: string;
  channelName?: string;
  agentName?: string;
  createdAt?: string;
  message_id?: string;
  channel_name?: string;
  agent_name?: string;
  created_at?: string;
}

interface RelaycastInbox {
  unreadChannels?: RelaycastUnreadChannel[];
  mentions?: RelaycastMention[];
  unreadDms?: RelaycastUnreadDm[];
  recentReactions?: RelaycastRecentReaction[];
  unread_channels?: RelaycastUnreadChannel[];
  unread_dms?: RelaycastUnreadDm[];
  recent_reactions?: RelaycastRecentReaction[];
}

interface DmConversationParticipant {
  agentName: string;
  agent_name?: string;
}

interface DmConversationSummary {
  id: string;
  participants: DmConversationParticipant[];
  lastMessage?: {
    id: string;
    text: string;
    agentName?: string;
    agent_name?: string;
    createdAt?: string;
    created_at?: string;
  } | null;
  last_message?: {
    id: string;
    text: string;
    agentName?: string;
    agent_name?: string;
    createdAt?: string;
    created_at?: string;
  } | null;
  unreadCount?: number;
  unread_count?: number;
  createdAt?: string;
  created_at?: string;
}

interface DmMessageItem {
  id: string;
  agentName?: string;
  agent_name?: string;
  text: string;
  createdAt?: string;
  created_at?: string;
}

interface NormalizedRelaycastMessage {
  id: string;
  agentName: string;
  text: string;
  createdAt: string;
}

interface NormalizedRelaycastUnreadChannel {
  channelName: string;
  unreadCount: number;
}

interface NormalizedRelaycastMention {
  id: string;
  channelName: string;
  agentName: string;
  text: string;
  createdAt: string;
}

interface NormalizedRelaycastLastMessage {
  id: string;
  text: string;
  createdAt: string;
}

interface NormalizedRelaycastUnreadDm {
  conversationId: string;
  from: string;
  unreadCount: number;
  lastMessage: NormalizedRelaycastLastMessage | null;
}

interface NormalizedRelaycastRecentReaction {
  emoji: string;
  messageId: string;
  channelName: string;
  agentName: string;
  createdAt: string;
}

interface NormalizedRelaycastInbox {
  unreadChannels: NormalizedRelaycastUnreadChannel[];
  mentions: NormalizedRelaycastMention[];
  unreadDms: NormalizedRelaycastUnreadDm[];
  recentReactions: NormalizedRelaycastRecentReaction[];
}

export interface MessagingRelaycastClient {
  message(id: string): Promise<RelaycastMessage>;
  messages(
    channel: string,
    options?: { limit?: number; before?: string; after?: string }
  ): Promise<RelaycastMessage[]>;
  inbox(): Promise<RelaycastInbox>;
  dm(to: string, text: string): Promise<void>;
  post(channel: string, text: string): Promise<void>;
  dms: {
    conversations(): Promise<DmConversationSummary[]>;
    messages(conversationId: string, opts?: { limit?: number }): Promise<DmMessageItem[]>;
  };
}

export interface MessagingBrokerClient {
  sendMessage(input: { to: string; text: string; from?: string; threadId?: string }): Promise<unknown>;
  shutdown(): Promise<unknown>;
}

export interface MessagingDependencies {
  getProjectRoot: () => string;
  createClient: (cwd: string) => MessagingBrokerClient | Promise<MessagingBrokerClient>;
  createRelaycastClient: (options: { agentName: string; cwd: string }) => Promise<MessagingRelaycastClient>;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: ExitFn;
}


function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function readString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toISOString();
}

function normalizeMessage(message: RelaycastMessage): NormalizedRelaycastMessage | null {
  const agentName = readString(message.agentName, message.agent_name);
  const createdAt = normalizeIsoTimestamp(readString(message.createdAt, message.created_at));
  if (!agentName || !createdAt) {
    return null;
  }

  return {
    id: message.id,
    agentName,
    text: message.text,
    createdAt,
  };
}

function normalizeUnreadChannel(channel: RelaycastUnreadChannel): NormalizedRelaycastUnreadChannel | null {
  const channelName = readString(channel.channelName, channel.channel_name);
  const unreadCount = readNumber(channel.unreadCount, channel.unread_count);
  if (!channelName || unreadCount === undefined) {
    return null;
  }

  return {
    channelName,
    unreadCount,
  };
}

function normalizeMention(mention: RelaycastMention): NormalizedRelaycastMention | null {
  const channelName = readString(mention.channelName, mention.channel_name);
  const agentName = readString(mention.agentName, mention.agent_name);
  const createdAt = normalizeIsoTimestamp(readString(mention.createdAt, mention.created_at));
  if (!channelName || !agentName || !createdAt) {
    return null;
  }

  return {
    id: mention.id,
    channelName,
    agentName,
    text: mention.text,
    createdAt,
  };
}

function normalizeLastMessage(
  message: RelaycastLastMessage | null | undefined
): NormalizedRelaycastLastMessage | null {
  if (!message) {
    return null;
  }

  const createdAt = normalizeIsoTimestamp(readString(message.createdAt, message.created_at));
  if (!createdAt) {
    return null;
  }

  return {
    id: message.id,
    text: message.text,
    createdAt,
  };
}

function normalizeUnreadDm(dm: RelaycastUnreadDm): NormalizedRelaycastUnreadDm | null {
  const conversationId = readString(dm.conversationId, dm.conversation_id);
  const unreadCount = readNumber(dm.unreadCount, dm.unread_count);
  if (!conversationId || unreadCount === undefined) {
    return null;
  }

  return {
    conversationId,
    from: dm.from,
    unreadCount,
    lastMessage: normalizeLastMessage(dm.lastMessage ?? dm.last_message),
  };
}

function normalizeRecentReaction(
  reaction: RelaycastRecentReaction
): NormalizedRelaycastRecentReaction | null {
  const messageId = readString(reaction.messageId, reaction.message_id);
  const channelName = readString(reaction.channelName, reaction.channel_name);
  const agentName = readString(reaction.agentName, reaction.agent_name);
  const createdAt = normalizeIsoTimestamp(readString(reaction.createdAt, reaction.created_at));
  if (!messageId || !channelName || !agentName || !createdAt) {
    return null;
  }

  return {
    emoji: reaction.emoji,
    messageId,
    channelName,
    agentName,
    createdAt,
  };
}

function normalizeInbox(inbox: RelaycastInbox | null | undefined): NormalizedRelaycastInbox {
  const unreadChannelsRaw = inbox?.unreadChannels ?? inbox?.unread_channels;
  const mentionsRaw = inbox?.mentions;
  const unreadDmsRaw = inbox?.unreadDms ?? inbox?.unread_dms;
  const recentReactionsRaw = inbox?.recentReactions ?? inbox?.recent_reactions;

  return {
    unreadChannels: (Array.isArray(unreadChannelsRaw) ? unreadChannelsRaw : [])
      .map(normalizeUnreadChannel)
      .filter(isPresent),
    mentions: (Array.isArray(mentionsRaw) ? mentionsRaw : []).map(normalizeMention).filter(isPresent),
    unreadDms: (Array.isArray(unreadDmsRaw) ? unreadDmsRaw : []).map(normalizeUnreadDm).filter(isPresent),
    recentReactions: (Array.isArray(recentReactionsRaw) ? recentReactionsRaw : [])
      .map(normalizeRecentReaction)
      .filter(isPresent),
  };
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

async function resolveRelaycastApiKey(cwd: string): Promise<string> {
  const envApiKey = process.env.RELAY_API_KEY?.trim();
  if (envApiKey) {
    return envApiKey;
  }

  let client: AgentRelayClient;
  try {
    client = AgentRelayClient.connect({ cwd });
  } catch {
    throw new Error(
      'Failed to read broker connection metadata. Start the broker with `agent-relay up` or set RELAY_API_KEY.'
    );
  }

  try {
    const session = await client.getSession();
    const workspaceKey = session.workspace_key ?? client.workspaceKey;
    if (workspaceKey && typeof workspaceKey === 'string' && workspaceKey.trim()) {
      return workspaceKey.trim();
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to query broker session: ${detail}`);
  } finally {
    client.disconnect();
  }

  throw new Error('No Relaycast workspace key found. Set RELAY_API_KEY or start broker with agent-relay up.');
}

async function createDefaultRelaycastClient(options: {
  agentName: string;
  cwd: string;
}): Promise<MessagingRelaycastClient> {
  const apiKey = await resolveRelaycastApiKey(options.cwd);
  const baseUrl = process.env.RELAYCAST_BASE_URL ?? 'https://api.relaycast.dev';
  const relaycast = new RelayCast({ apiKey, baseUrl });
  const registration = await relaycast.agents.registerOrGet({
    name: options.agentName,
    type: 'agent',
  });
  const agentClient = relaycast.as(registration.token);
  // AgentClient already has dm(agent, text) — preserve the original reference before casting.
  // post() bridges to AgentClient.send() which has a different name.
  const originalDm = agentClient.dm.bind(agentClient);
  const originalSend = (agentClient as any).send.bind(agentClient);
  const client = agentClient as unknown as MessagingRelaycastClient;
  client.dm = async (to: string, text: string) => {
    await originalDm(to, text);
  };
  client.post = async (channel: string, text: string) => {
    await originalSend(channel, text);
  };
  return client;
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
    .option('--from <name>', 'Sender name (registered identity in relaycast, defaults to "relay")')
    .option('--thread <id>', 'Thread identifier')
    .action(async (agent: string, message: string, options: { from?: string; thread?: string }) => {
      const senderName = options.from?.trim() || 'relay';
      const isChannel = agent.startsWith('#');

      // Primary path: send via relaycast SDK so messages are stored and queryable
      // Skip relaycast path when --thread is used since the relaycast SDK does not support threading
      if (!options.thread) {
        try {
          const relaycastClient = await deps.createRelaycastClient({
            agentName: senderName,
            cwd: deps.getProjectRoot(),
          });
          if (isChannel) {
            await relaycastClient.post(agent.slice(1), message);
          } else {
            await relaycastClient.dm(agent, message);
          }
          deps.log(`Message sent to ${agent}`);
          return;
        } catch {
          // Fall through to broker path
        }
      }

      // Fallback: broker path (for environments without relaycast API key)
      let brokerClient: MessagingBrokerClient;
      try {
        brokerClient = await deps.createClient(deps.getProjectRoot());
      } catch (err: any) {
        deps.error(`Failed to connect to broker: ${err?.message || String(err)}`);
        deps.error('Start the broker with `agent-relay up` and try again.');
        deps.exit(1);
        return;
      }

      try {
        await brokerClient.sendMessage({
          to: agent,
          text: message,
          from: options.from?.trim() ? options.from.trim() : undefined,
          threadId: options.thread,
        });
        deps.log(`Message sent to ${agent}`);
      } catch (err: any) {
        deps.error(`Failed to send message: ${err?.message || String(err)}`);
        deps.exit(1);
      } finally {
        await brokerClient.shutdown().catch(() => undefined);
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
        deps.exit(1);
        return;
      }

      try {
        const msg = await relaycast.message(messageId);
        const normalizedMessage = normalizeMessage(msg);
        if (!normalizedMessage) {
          throw new Error(`message ${messageId} is missing sender or timestamp metadata`);
        }

        deps.log(`From: ${normalizedMessage.agentName}`);
        deps.log('To: #channel');
        deps.log(`Time: ${normalizedMessage.createdAt}`);
        deps.log('---');
        deps.log(normalizedMessage.text);
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

        if (options.from && !options.to) {
          // Cross-context sender history: channel messages + DMs sent by this agent
          const channelItems: Array<{ ts: string; to: string; text: string; kind: 'channel' }> = [];
          const dmItems: Array<{ ts: string; to: string; text: string; kind: 'dm' }> = [];

          // Part 1: channel messages from this agent
          try {
            const channelClient = await deps.createRelaycastClient({
              agentName: '__cli_history__',
              cwd: deps.getProjectRoot(),
            });
            const raw = (await channelClient.messages('general', { limit: Math.max(limit * 2, 100) }))
              .map(normalizeMessage)
              .filter(isPresent)
              .filter((msg) => msg.agentName === options.from)
              .filter((msg) => !sinceTs || Date.parse(msg.createdAt) >= sinceTs)
              .slice(0, limit);
            for (const msg of raw) {
              channelItems.push({ ts: msg.createdAt, to: '#general', text: msg.text, kind: 'channel' });
            }
          } catch {
            // non-fatal — continue to DM section
          }

          // Part 2: DM messages sent by this agent
          try {
            const dmClient = await deps.createRelaycastClient({
              agentName: options.from,
              cwd: deps.getProjectRoot(),
            });
            const conversations = await dmClient.dms.conversations();
            const perConvLimit = Math.max(Math.ceil(limit / Math.max(conversations.length, 1)), 10);
            for (const conv of conversations.slice(0, 10)) {
              const msgs = await dmClient.dms.messages(conv.id, { limit: perConvLimit });
              const recipient =
                conv.participants
                  .filter((p) => (p.agentName || p.agent_name) !== options.from)
                  .map((p) => p.agentName || p.agent_name)
                  .join(', ') || '(self)';
              for (const m of msgs) {
                const sender = m.agentName || m.agent_name;
                if (sender !== options.from) continue;
                const ts = m.createdAt || m.created_at || '';
                if (sinceTs && Date.parse(ts) < sinceTs) continue;
                dmItems.push({ ts, to: recipient, text: m.text, kind: 'dm' });
              }
            }
          } catch {
            // non-fatal — continue with channel results only
          }

          const allItems = [...channelItems, ...dmItems].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

          if (options.json) {
            deps.log(
              JSON.stringify(
                allItems.map((item) => ({
                  from: options.from,
                  to: item.to,
                  text: item.text,
                  createdAt: item.ts,
                  kind: item.kind,
                })),
                null,
                2
              )
            );
            return;
          }

          if (!allItems.length) {
            deps.log('No messages found.');
            return;
          }

          allItems.forEach((item) => {
            const body = item.text.length > 200 ? item.text.slice(0, 197) + '...' : item.text;
            if (item.kind === 'dm') {
              deps.log('[' + item.ts + '] ' + options.from + ' -> ' + item.to + ' (DM): ' + body);
            } else {
              deps.log('[' + item.ts + '] ' + options.from + ' -> ' + item.to + ': ' + body);
            }
          });
          return;
        }

        if (options.to && !options.to.startsWith('#')) {
          // DM history mode: register as the target agent and show their conversations
          let dmClient: MessagingRelaycastClient;
          try {
            dmClient = await deps.createRelaycastClient({
              agentName: options.to,
              cwd: deps.getProjectRoot(),
            });
          } catch (err: any) {
            deps.error(`Failed to initialize relaycast client: ${err?.message || String(err)}`);
            deps.exit(1);
            return;
          }

          try {
            const conversations = await dmClient.dms.conversations();

            if (options.from) {
              // Show messages in the specific conversation with --from agent
              const conv = conversations.find((c) =>
                c.participants.some((p) => (p.agentName || p.agent_name) === options.from)
              );
              if (!conv) {
                deps.log(`No DM conversation found between ${options.to} and ${options.from}.`);
                return;
              }
              const messages = await dmClient.dms.messages(conv.id, { limit });
              if (options.json) {
                deps.log(
                  JSON.stringify(
                    messages.map((m) => ({
                      id: m.id,
                      from: m.agentName || m.agent_name || 'unknown',
                      text: m.text,
                      createdAt: m.createdAt || m.created_at,
                    })),
                    null,
                    2
                  )
                );
                return;
              }
              if (!messages.length) {
                deps.log('No messages found.');
                return;
              }
              messages.forEach((m) => {
                const sender = m.agentName || m.agent_name || 'unknown';
                const ts = m.createdAt || m.created_at || '';
                const body = m.text.length > 200 ? `${m.text.slice(0, 197)}...` : m.text;
                deps.log(`[${ts}] ${sender}: ${body}`);
              });
            } else {
              // Show all conversations summary
              if (options.json) {
                deps.log(JSON.stringify(conversations, null, 2));
                return;
              }
              if (!conversations.length) {
                deps.log(`No DM conversations found for ${options.to}.`);
                return;
              }
              deps.log(`DM conversations for ${options.to}:`);
              conversations.forEach((conv) => {
                const others = conv.participants
                  .filter((p) => (p.agentName || p.agent_name) !== options.to)
                  .map((p) => p.agentName || p.agent_name)
                  .join(', ');
                const lastText = (conv.lastMessage || conv.last_message)?.text ?? '(no messages)';
                const preview = lastText.length > 60 ? `${lastText.slice(0, 57)}...` : lastText;
                const unread = conv.unreadCount ?? conv.unread_count ?? 0;
                deps.log(`  ${others || '(self)'}: "${preview}" [${unread} unread]`);
              });
            }
          } catch (err: any) {
            deps.error(`Failed to fetch DM history: ${err?.message || String(err)}`);
            deps.exit(1);
          }
          return;
        }

        let relaycast: MessagingRelaycastClient;

        try {
          relaycast = await deps.createRelaycastClient({
            agentName: '__cli_history__',
            cwd: deps.getProjectRoot(),
          });
        } catch (err: any) {
          deps.error(`Failed to initialize relaycast client: ${err?.message || String(err)}`);
          deps.exit(1);
          return;
        }

        try {
          const channel = options.to ? options.to.slice(1) : 'general';
          const messages = (
            await relaycast.messages(channel, {
              limit: Math.max(limit * 2, 100),
            })
          )
            .map(normalizeMessage)
            .filter(isPresent);

          let filteredMessages = messages.filter((msg) => {
            const createdAtMs = Date.parse(msg.createdAt);
            if (options.from && msg.agentName !== options.from) return false;
            if (sinceTs && createdAtMs < sinceTs) return false;
            return true;
          });

          filteredMessages = filteredMessages.slice(0, limit);

          if (options.json) {
            const payload = filteredMessages.map((msg) => ({
              id: msg.id,
              ts: Date.parse(msg.createdAt),
              timestamp: msg.createdAt,
              from: msg.agentName,
              to: `#${channel}`,
              thread: null,
              kind: 'message',
              body: msg.text,
              status: undefined,
            }));
            deps.log(JSON.stringify(payload, null, 2));
            return;
          }

          if (!filteredMessages.length) {
            deps.log('No messages found.');
            return;
          }

          filteredMessages.forEach((msg) => {
            const body = msg.text.length > 200 ? `${msg.text.slice(0, 197)}...` : msg.text;
            deps.log(`[${msg.createdAt}] ${msg.agentName} -> #${channel}: ${body}`);
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
    .option('--agent <name>', 'Agent whose inbox to check (defaults to cli user)')
    .option('--json', 'Output as JSON')
    .action(async (options: { agent?: string; json?: boolean }) => {
      let relaycast: MessagingRelaycastClient;
      try {
        relaycast = await deps.createRelaycastClient({
          agentName: options.agent?.trim() || '__cli_inbox__',
          cwd: deps.getProjectRoot(),
        });
      } catch (err: any) {
        deps.error(`Failed to initialize relaycast client: ${err?.message || String(err)}`);
        deps.exit(1);
        return;
      }

      try {
        const inbox = normalizeInbox(await relaycast.inbox());
        if (options.json) {
          const payload = {
            unread_channels: inbox.unreadChannels.map((item) => ({
              channel_name: item.channelName,
              unread_count: item.unreadCount,
            })),
            mentions: inbox.mentions.map((mention) => ({
              id: mention.id,
              channel_name: mention.channelName,
              agent_name: mention.agentName,
              text: mention.text,
              created_at: mention.createdAt,
            })),
            unread_dms: inbox.unreadDms.map((dm) => ({
              conversation_id: dm.conversationId,
              from: dm.from,
              unread_count: dm.unreadCount,
              last_message: dm.lastMessage
                ? {
                    id: dm.lastMessage.id,
                    text: dm.lastMessage.text,
                    created_at: dm.lastMessage.createdAt,
                  }
                : null,
            })),
            recent_reactions: inbox.recentReactions.map((reaction) => ({
              message_id: reaction.messageId,
              channel_name: reaction.channelName,
              emoji: reaction.emoji,
              agent_name: reaction.agentName,
              created_at: reaction.createdAt,
            })),
          };
          deps.log(JSON.stringify(payload, null, 2));
          return;
        }

        const hasContent =
          inbox.unreadChannels.length > 0 ||
          inbox.mentions.length > 0 ||
          inbox.unreadDms.length > 0 ||
          inbox.recentReactions.length > 0;

        if (!hasContent) {
          deps.log('Inbox is clear.');
          return;
        }

        if (inbox.unreadChannels.length > 0) {
          deps.log('Unread Channels:');
          for (const item of inbox.unreadChannels) {
            deps.log(`  #${item.channelName}: ${item.unreadCount}`);
          }
          deps.log('');
        }

        if (inbox.mentions.length > 0) {
          deps.log('Mentions:');
          for (const mention of inbox.mentions) {
            const preview = mention.text.length > 120 ? `${mention.text.slice(0, 117)}...` : mention.text;
            deps.log(`  [${mention.createdAt}] #${mention.channelName} @${mention.agentName}: ${preview}`);
          }
          deps.log('');
        }

        if (inbox.unreadDms.length > 0) {
          deps.log('Unread DMs:');
          for (const dm of inbox.unreadDms) {
            deps.log(`  ${dm.from}: ${dm.unreadCount}`);
          }
          deps.log('');
        }

        if (inbox.recentReactions.length > 0) {
          deps.log('Recent Reactions:');
          for (const reaction of inbox.recentReactions) {
            deps.log(
              `  [${reaction.createdAt}] #${reaction.channelName} ${reaction.emoji} by @${reaction.agentName}`
            );
          }
        }
      } catch (err: any) {
        deps.error(`Failed to fetch inbox: ${err?.message || String(err)}`);
        deps.exit(1);
      }
    });
}
